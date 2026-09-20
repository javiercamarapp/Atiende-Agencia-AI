// Port de prepareCreateOrder/createOrderCore/buscarProductosCore de
// restaurantes/supabase/functions/_shared/create-order-core.ts. El precio SIEMPRE se
// re-cotiza server-side contra el catálogo real de la sucursal — nunca se confía en
// un total mandado por el cliente/LLM (guardia anti-alucinación de precio, ver
// product-search.ts::resolveOrderItemsAgainstProducts).
import { createHash } from "node:crypto";
import { OrderValidationError } from "./errors.ts";
import { tryNotifyCustomerOrderConfirmationEmail, tryNotifyStaffNewOrder } from "./order-notifications.ts";
import { normalizePhone, canonicalizeMexicanPhone } from "./phone.ts";
import { buildComplementNotes, buildOrderQuoteFromProducts, DEFAULT_COMPLEMENTS } from "./order-quote.ts";
import { applyPromotionToOrderTotal, normalizePromotionCode } from "./promotions.ts";
import { extraerPackSize, matchesProductSearch, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, tokenizeForProductSearch, UUID_PATTERN } from "./product-search.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, CreateOrderInput, Order, PersistedOrderItem, Promotion, ProductoEncontrado, RequestedOrderItemInput } from "./types.ts";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Mismo regex exacto que admin-staff.ts::EMAIL_RE y el CHECK de
// restaurantes.orders.customer_email (migrations/011_email_outbox_dispatch.sql)
// — validación deliberadamente laxa (formato, no existencia real del buzón):
// suficiente para no encolar un correo con un valor obviamente inválido.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toProductoEncontrado(product: { id: string; name: string; description: string | null; categoryName: string | null; price: number }): ProductoEncontrado {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    packSize: extraerPackSize(product.name, product.description),
    requiresAdultConfirmation: requiresAdultConfirmation(product.name, product.categoryName),
  };
}

/** Búsqueda real de productos disponibles en una sucursal — port literal de
 * buscarProductosCore, incluyendo el fix real del 4-sep-2026 (match contra name,
 * description, categoría Y search_keywords, no solo name). */
export async function searchProducts(repo: RestaurantesRepository, args: { readonly propertyId: string; readonly query: string }): Promise<ProductoEncontrado[]> {
  const tokens = tokenizeForProductSearch(args.query);
  const catalog = await repo.listAvailableProductsForBranch(args.propertyId);
  return catalog
    .filter((p) => matchesProductSearch(tokens, { name: p.name, description: p.description, categoryName: p.categoryName, searchKeywords: p.searchKeywords }))
    .slice(0, 8)
    .map(toProductoEncontrado);
}

/**
 * Resuelve N renglones pedidos contra el catálogo real de la sucursal — guardia
 * anti-alucinación de precio compartida por `prepareCreateOrder` y `quoteOrder`
 * (Fase 2 §1.3): extraída aquí como función exportada porque `quoteOrder`
 * necesita cotizar ANTES de tener los datos de cliente que exige
 * `prepareCreateOrder` (nombre/teléfono/dirección) — la resolución de
 * productos es exactamente la misma en ambos casos, solo cambia qué se hace
 * después con el resultado.
 */
export async function resolveBranchOrderItems(
  repo: RestaurantesRepository,
  propertyId: string,
  items: readonly RequestedOrderItemInput[],
): Promise<{ items: Array<RequestedOrderItemInput & { productId: string; productName: string }>; products: ProductoEncontrado[] }> {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw new OrderValidationError("El pedido no tiene productos válidos");
  }
  for (const item of items) {
    const idValid = typeof item.productId === "string" && UUID_PATTERN.test(item.productId);
    const nameValid = typeof item.productName === "string" && item.productName.trim().length > 0 && item.productName.length <= 240;
    if (!idValid && !nameValid) {
      throw new OrderValidationError("Cada producto requiere un id válido o el nombre exacto devuelto por la búsqueda de productos.");
    }
  }
  const catalog = await repo.listAvailableProductsForBranch(propertyId);
  const products = catalog.map(toProductoEncontrado);
  return { items: resolveOrderItemsAgainstProducts(items, products), products };
}

interface ValidatedCreateOrderInput extends CreateOrderInput {
  readonly customerPhone: string;
}

function invalidOptionalString(value: unknown, maxLength: number): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.length > maxLength);
}

/** Port literal de validateCreateOrderPayload — contrato único para pedidos reales
 * y simulados, sin efectos secundarios. */
export function validateCreateOrderPayload(raw: CreateOrderInput): ValidatedCreateOrderInput {
  if (!raw || typeof raw !== "object") throw new OrderValidationError("Payload inválido");
  const hasBranch = (typeof raw.branchSlug === "string" && raw.branchSlug.trim()) || (typeof raw.branchName === "string" && raw.branchName.trim());
  if (!hasBranch || typeof raw.customerName !== "string" || !raw.customerName.trim() || typeof raw.customerPhone !== "string" || !raw.customerPhone.trim()) {
    throw new OrderValidationError("branchSlug (o branchName), customerName y customerPhone son requeridos");
  }
  if (
    raw.customerName.trim().length > 160 ||
    raw.customerPhone.length > 64 ||
    invalidOptionalString(raw.branchSlug, 100) ||
    invalidOptionalString(raw.branchName, 160) ||
    invalidOptionalString(raw.customerAddress, 1000) ||
    invalidOptionalString(raw.notes, 2000) ||
    invalidOptionalString(raw.callTranscript, 20000) ||
    invalidOptionalString(raw.callRecordingUrl, 2000) ||
    invalidOptionalString(raw.promoCode, 40)
  ) {
    throw new OrderValidationError("Uno o más campos exceden el tamaño permitido");
  }
  if (raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 200)) {
    throw new OrderValidationError("idempotencyKey inválido");
  }
  if (raw.customerEmail !== undefined && raw.customerEmail !== null && raw.customerEmail.trim() !== "" && (typeof raw.customerEmail !== "string" || raw.customerEmail.trim().length > 320 || !EMAIL_RE.test(raw.customerEmail.trim()))) {
    throw new OrderValidationError("customerEmail inválido");
  }
  const agentOrder = raw.source === "voice" || raw.source === "whatsapp";
  if (agentOrder && (typeof raw.customerAddress !== "string" || !raw.customerAddress.trim())) {
    throw new OrderValidationError("La dirección completa de entrega es requerida");
  }
  if (
    (agentOrder && raw.paymentMethod !== "efectivo" && raw.paymentMethod !== "tarjeta") ||
    (!agentOrder && raw.paymentMethod !== undefined && raw.paymentMethod !== "efectivo" && raw.paymentMethod !== "tarjeta")
  ) {
    throw new OrderValidationError("La forma de pago debe ser efectivo o tarjeta");
  }
  const voicePhone = raw.source === "voice" ? canonicalizeMexicanPhone(raw.customerPhone) : null;
  if (raw.source === "voice" && !voicePhone) {
    throw new OrderValidationError("Teléfono inválido: confirma exactamente 10 dígitos y vuelve a leerlos al cliente en grupos 3-3-4.");
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 100) {
    throw new OrderValidationError("El pedido no tiene productos");
  }
  for (const item of raw.items) {
    if (
      !item ||
      typeof item !== "object" ||
      (item.productId !== undefined && (typeof item.productId !== "string" || item.productId.length > 64)) ||
      (item.productName !== undefined && (typeof item.productName !== "string" || item.productName.length > 240)) ||
      (!(typeof item.productId === "string" && UUID_PATTERN.test(item.productId)) && !(typeof item.productName === "string" && item.productName.trim())) ||
      (item.tortilla !== undefined && item.tortilla !== "maiz" && item.tortilla !== "harina")
    ) {
      throw new OrderValidationError("Productos o cantidades inválidos");
    }
    const hasQuantity = item.quantity !== undefined;
    const hasRequested = item.requestedQuantity !== undefined;
    if (hasQuantity === hasRequested) throw new OrderValidationError("Productos o cantidades inválidos");
    const value = hasRequested ? item.requestedQuantity : item.quantity;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) {
      throw new OrderValidationError("Productos o cantidades inválidos");
    }
  }

  return {
    ...raw,
    branchSlug: raw.branchSlug?.trim() || undefined,
    branchName: raw.branchName?.trim() || undefined,
    customerName: raw.customerName.trim(),
    customerPhone: voicePhone ?? normalizePhone(raw.customerPhone),
    customerAddress: raw.customerAddress?.trim(),
    customerEmail: raw.customerEmail?.trim() ? raw.customerEmail.trim().toLowerCase() : undefined,
    promoCode: raw.promoCode?.trim() ? normalizePromotionCode(raw.promoCode) : undefined,
  };
}

export interface PreparedOrder {
  readonly payload: ValidatedCreateOrderInput;
  readonly branch: Branch;
  readonly orderItems: readonly PersistedOrderItem[];
  readonly total: number;
  readonly containsAlcohol: boolean;
  /** Fase 11 — promoción real aplicada a este pedido (ver promotions.ts), null si
   * `payload.promoCode` no venía o no fue necesario resolverla todavía. */
  readonly appliedPromotion: Promotion | null;
  /** Descuento real ya restado de `total` — 0 cuando no hay promoción aplicada. */
  readonly discount: number;
}

/** Cotiza un pedido completo contra el catálogo real, SIN persistir — usado también
 * por el modo de vista previa. Precio y disponibilidad siempre vienen de
 * branch_products, la fuente real por sucursal. */
export async function prepareCreateOrder(repo: RestaurantesRepository, rawInput: CreateOrderInput): Promise<PreparedOrder> {
  const payload = validateCreateOrderPayload(rawInput);

  const branch = await repo.findBranch(payload.organizationId, { slug: payload.branchSlug, name: payload.branchName });
  if (!branch || branch.status !== "active") {
    throw new OrderValidationError(`Sucursal '${payload.branchSlug ?? payload.branchName}' no encontrada o inactiva`);
  }

  const resolved = await resolveBranchOrderItems(
    repo,
    branch.propertyId,
    payload.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      requestedQuantity: Number.isInteger(item.requestedQuantity) ? (item.requestedQuantity as number) : 1,
      tortilla: item.tortilla,
    })),
  );

  const orderItems: PersistedOrderItem[] = [];
  let total = 0;
  let containsAlcohol = false;

  for (const [index, inputItem] of payload.items.entries()) {
    const canonicalItem = resolved.items[index]!;
    const product = resolved.products.find((candidate) => candidate.id === canonicalItem.productId)!;
    const requiresAdult = product.requiresAdultConfirmation;
    if (requiresAdult) containsAlcohol = true;
    const isAgentOrder = payload.source === "voice" || payload.source === "whatsapp";
    if (requiresAdult && isAgentOrder && payload.adultConfirmed !== true) {
      throw new OrderValidationError(`Antes de crear el pedido con ${product.name}, confirma de forma explícita que quien recibe el pedido es mayor de edad.`);
    }
    const requestedPieces = Number.isInteger(inputItem.requestedQuantity);
    const quote = buildOrderQuoteFromProducts(
      [
        {
          productId: canonicalItem.productId,
          productName: canonicalItem.productName,
          requestedQuantity: (requestedPieces ? inputItem.requestedQuantity : inputItem.quantity) as number,
          tortilla: inputItem.tortilla,
        },
      ],
      [{ ...product, packSize: requestedPieces ? product.packSize : null }],
      { adultConfirmed: payload.adultConfirmed || (!requestedPieces && !isAgentOrder) },
    ).lines[0]!;

    if (!Number.isInteger(quote.quantity) || quote.quantity <= 0) {
      throw new OrderValidationError(`Cantidad inválida para ${product.name}`);
    }
    const lineTotal = Math.round(product.price * quote.quantity * 100) / 100;
    total = Math.round((total + lineTotal) * 100) / 100;
    orderItems.push({
      id: product.id,
      name: product.name,
      price: product.price,
      quantity: quote.quantity,
      ...(quote.tortilla ? { tortilla: quote.tortilla } : {}),
    });
  }

  // Fase 11 — promociones/marketing (ver promotions.ts para el porqué de este
  // gap y por qué es deliberadamente nuevo respecto al original). Se aplica DESPUÉS
  // de sumar todos los renglones -- nunca antes -- así min_order_total siempre
  // evalúa el total REAL del pedido, nunca uno parcial. Reusa `applyPromotionToOrderTotal`
  // sobre el `total` que ya calculó el motor de cotización de arriba: cero
  // duplicación de la lógica de precio de línea.
  let appliedPromotion: Promotion | null = null;
  let discount = 0;
  if (payload.promoCode) {
    const promotion = await repo.findPromotionByCode(payload.organizationId, payload.promoCode);
    if (!promotion) {
      throw new OrderValidationError(`El código "${payload.promoCode}" no existe.`);
    }
    const applied = applyPromotionToOrderTotal(total, promotion, new Date());
    total = applied.total;
    discount = applied.discount;
    appliedPromotion = promotion;
  }

  return { payload, branch, orderItems, total, containsAlcohol, appliedPromotion, discount };
}

/**
 * Fase 11 de `createOrder` (ver su comentario de cabecera en el call site) — registra
 * el uso real de una promoción DESPUÉS de persistir el pedido, best-effort real: un
 * fallo aquí nunca revierte un pedido ya creado.
 *
 * SAVEPOINT (corrección de revisión sobre PR #176, auditoría a3, no bloqueante #2):
 * mismo patrón que `tryNotifyStaffNewOrder`/`tryNotifyCustomerOrderConfirmationEmail`
 * de `order-notifications.ts` -- este best-effort corre DENTRO de la MISMA
 * transacción que ya persistió el pedido (`create_order_idempotent`). Sin
 * `runWithRowSavepoint`, un error real de Postgres en `increment_promotion_uses`
 * (deadlock/timeout transitorio) dejaría la transacción en 25P02 y el `commit;` que
 * sigue perdería el pedido ya "persistido", detectado como `AbortedTransactionCommitError`
 * por `managed-postgres-engine.ts` (500 honesto, nunca un rollback silencioso).
 * Extraída a función propia (antes inline en `createOrder`) para poder probar el
 * SAVEPOINT directamente contra `PostgresRestaurantesRepository` real +
 * `AbortAwareFakeSession`, mismo criterio que las otras dos, sin tener que montar
 * todo `createOrder` (catálogo, sucursal, cliente, idempotencia) solo para esto —
 * ver `order-notifications-createorder-savepoint.spec.ts`.
 */
export async function tryIncrementPromotionUses(repo: RestaurantesRepository, organizationId: string, promotionId: string): Promise<void> {
  try {
    await repo.runWithRowSavepoint(() => repo.incrementPromotionUses(organizationId, promotionId));
  } catch (err) {
    console.error("promotions: best-effort incrementPromotionUses failed:", err);
  }
}

/**
 * Crea el pedido de verdad: memoria de cliente (upsertCustomer, ver customers.ts) +
 * inserción idempotente de dos niveles (idempotencyKey explícito + dedupeFingerprint
 * automático de 5 minutos) — nunca dos filas reales por una sola intención real de
 * pedido (protección real y a prueba de canal, port literal de createOrderCore).
 */
export async function createOrder(repo: RestaurantesRepository, rawInput: CreateOrderInput): Promise<Order> {
  const { payload, branch, orderItems, total, containsAlcohol, appliedPromotion, discount } = await prepareCreateOrder(repo, rawInput);

  const customer = await repo.upsertCustomer(payload.organizationId, payload.customerPhone, payload.customerName);
  if (payload.customerAddress) await repo.addCustomerAddressIfNew(customer.id, payload.customerAddress);

  const itemsOrdenados = [...orderItems].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const complementNotes = buildComplementNotes(payload.notes, [...new Set(payload.requestedComplements ?? [])].sort(), [...new Set(payload.omitDefaultComplements ?? [])].sort());
  const notesWithAlcohol = containsAlcohol ? [complementNotes, "Recepción de alcohol: mayoría de edad confirmada por el cliente."].join("\n") : complementNotes;
  // Fase 11 — el descuento real ya está restado de `total` (ver prepareCreateOrder);
  // esta nota es solo auditoría legible por el staff en el panel de pedidos, nunca
  // la fuente de verdad del descuento (eso es `total` + `appliedPromotion`).
  const finalNotes = appliedPromotion ? [notesWithAlcohol, `Promoción aplicada: ${appliedPromotion.code} (-$${discount.toFixed(2)}).`].join("\n") : notesWithAlcohol;

  const dedupeFingerprint = sha256Hex(
    JSON.stringify({
      organization_id: payload.organizationId,
      property_id: branch.propertyId,
      customer_name: payload.customerName,
      customer_phone: payload.customerPhone,
      customer_address: payload.customerAddress ?? null,
      payment_method: payload.paymentMethod ?? null,
      source: payload.source,
      notes: finalNotes,
      total,
      items: itemsOrdenados.map((item) => ({ id: item.id, name: item.name, price: item.price, quantity: item.quantity, tortilla: item.tortilla ?? null })),
      requested_complements: [...(payload.requestedComplements ?? [])].sort(),
      omit_default_complements: [...(payload.omitDefaultComplements ?? [])].sort(),
    }),
  );
  const idempotencyKey = payload.idempotencyKey ? sha256Hex(`${payload.organizationId}:${payload.idempotencyKey}`) : null;

  // create_order_idempotent (ver migrations/003) nunca lanza en el camino feliz de un
  // reintento: si ya existe un pedido con la misma idempotencyKey o el mismo
  // dedupeFingerprint reciente en pending, lo DEVUELVE en vez de insertar uno nuevo
  // — nunca dos filas reales por una sola intención real de pedido. Un error real
  // aquí (violación de formato, fallo de conexión) se propaga tal cual, nunca se
  // reclasifica en silencio como conflicto.
  const order = await repo.createOrderIdempotent(
    {
      organizationId: payload.organizationId,
      propertyId: branch.propertyId,
      customerId: customer.id,
      customerName: payload.customerName,
      customerPhone: payload.customerPhone,
      customerAddress: payload.customerAddress ?? null,
      customerEmail: payload.customerEmail ?? null,
      branch: branch.name,
      total,
      items: orderItems,
      source: payload.source,
      notes: finalNotes,
      paymentMethod: payload.paymentMethod ?? null,
      callTranscript: payload.callTranscript ?? null,
      callRecordingUrl: payload.callRecordingUrl ?? null,
    },
    dedupeFingerprint,
    idempotencyKey,
  );

  // Fase 9 — "nuevo pedido entrante" al staff (ver order-notifications.ts, gap real
  // verificado: `createOrder` nunca disparaba ningún aviso). Best-effort e
  // idempotente por (organizationId, orderId, eventType) -- un reintento real de
  // create_order_idempotent que devuelve el MISMO pedido (misma idempotencyKey o
  // dedupeFingerprint) nunca duplica la notificación.
  await tryNotifyStaffNewOrder(repo, order);

  // Fase de correo — confirmación de pedido por correo real, best-effort e
  // idempotente por (organizationId, channel, dedupeKey) igual que la línea de
  // arriba: cuando el cliente no dejó correo (voz/WhatsApp, o web sin llenarlo),
  // `notifyCustomerOrderConfirmationEmailCore` simplemente no encola nada — ver
  // order-notifications.ts.
  await tryNotifyCustomerOrderConfirmationEmail(repo, order);

  // Fase 11 — registra el uso real de la promoción DESPUÉS de persistir el pedido
  // (nunca antes: un pedido que falla al crearse no debe consumir un uso). Igual
  // que create_order_idempotent, un reintento con la MISMA idempotencyKey/
  // dedupeFingerprint devuelve el pedido ya existente sin volver a ejecutar este
  // bloque (createOrderIdempotent ya retornó antes de llegar aquí en ese caso...
  // salvo que sí llega, así que se reincrementaría en un reintento real: se acepta
  // porque el pedido en sí nunca se duplica -- ver nota de idempotencia de arriba --
  // un reintento de red del MISMO request real es indistinguible aquí de dos
  // pedidos reales con el mismo código, y no hay forma barata de diferenciarlos
  // sin una tabla de uso por pedido, fuera de alcance de esta fase). Best-effort:
  // nunca revierte un pedido real ya creado por esto.
  if (appliedPromotion) {
    await tryIncrementPromotionUses(repo, payload.organizationId, appliedPromotion.id);
  }
  return order;
}

/**
 * cotizar_pedido real (Fase 2 §1.3) — cotiza N renglones contra el catálogo
 * real de la sucursal SIN persistir nada y sin exigir todavía nombre/teléfono
 * de cliente (a diferencia de `prepareCreateOrder`, que sí los exige). El
 * agente (voz o WhatsApp) la llama ANTES de decir cualquier total o preguntar
 * la forma de pago — el cálculo de piezas->paquetes, tortilla obligatoria y
 * confirmación de mayoría de edad vive completo en
 * `buildOrderQuoteFromProducts` (order-quote.ts), sin tocar una línea: este
 * wrapper solo resuelve la sucursal y los renglones, la lógica de cotización
 * en sí no cambia.
 */
export async function quoteOrder(
  repo: RestaurantesRepository,
  args: {
    readonly organizationId: string;
    readonly branchSlug: string;
    readonly items: readonly RequestedOrderItemInput[];
    readonly adultConfirmed?: boolean;
  },
) {
  const branch = await repo.findBranch(args.organizationId, { slug: args.branchSlug });
  if (!branch || branch.status !== "active") {
    throw new OrderValidationError(`Sucursal '${args.branchSlug}' no encontrada o inactiva`);
  }
  const resolved = await resolveBranchOrderItems(repo, branch.propertyId, args.items);
  return buildOrderQuoteFromProducts(resolved.items, resolved.products, { adultConfirmed: args.adultConfirmed });
}

export { DEFAULT_COMPLEMENTS };
