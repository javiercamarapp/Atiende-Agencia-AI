// Port de prepareCreateOrder/createOrderCore/buscarProductosCore de
// restaurantes/supabase/functions/_shared/create-order-core.ts. El precio SIEMPRE se
// re-cotiza server-side contra el catálogo real de la sucursal — nunca se confía en
// un total mandado por el cliente/LLM (guardia anti-alucinación de precio, ver
// product-search.ts::resolveOrderItemsAgainstProducts).
import { createHash } from "node:crypto";
import { OrderValidationError } from "./errors.ts";
import { normalizePhone, canonicalizeMexicanPhone } from "./phone.ts";
import { buildComplementNotes, buildOrderQuoteFromProducts, DEFAULT_COMPLEMENTS } from "./order-quote.ts";
import { extraerPackSize, matchesProductSearch, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, tokenizeForProductSearch, UUID_PATTERN } from "./product-search.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, CreateOrderInput, Order, PersistedOrderItem, ProductoEncontrado, RequestedOrderItemInput } from "./types.ts";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

async function resolveBranchOrderItems(
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
    invalidOptionalString(raw.callRecordingUrl, 2000)
  ) {
    throw new OrderValidationError("Uno o más campos exceden el tamaño permitido");
  }
  if (raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 200)) {
    throw new OrderValidationError("idempotencyKey inválido");
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
  };
}

export interface PreparedOrder {
  readonly payload: ValidatedCreateOrderInput;
  readonly branch: Branch;
  readonly orderItems: readonly PersistedOrderItem[];
  readonly total: number;
  readonly containsAlcohol: boolean;
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

  return { payload, branch, orderItems, total, containsAlcohol };
}

/**
 * Crea el pedido de verdad: memoria de cliente (upsertCustomer, ver customers.ts) +
 * inserción idempotente de dos niveles (idempotencyKey explícito + dedupeFingerprint
 * automático de 5 minutos) — nunca dos filas reales por una sola intención real de
 * pedido (protección real y a prueba de canal, port literal de createOrderCore).
 */
export async function createOrder(repo: RestaurantesRepository, rawInput: CreateOrderInput): Promise<Order> {
  const { payload, branch, orderItems, total, containsAlcohol } = await prepareCreateOrder(repo, rawInput);

  const customer = await repo.upsertCustomer(payload.organizationId, payload.customerPhone, payload.customerName);
  if (payload.customerAddress) await repo.addCustomerAddressIfNew(customer.id, payload.customerAddress);

  const itemsOrdenados = [...orderItems].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const complementNotes = buildComplementNotes(payload.notes, [...new Set(payload.requestedComplements ?? [])].sort(), [...new Set(payload.omitDefaultComplements ?? [])].sort());
  const finalNotes = containsAlcohol ? [complementNotes, "Recepción de alcohol: mayoría de edad confirmada por el cliente."].join("\n") : complementNotes;

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
  return repo.createOrderIdempotent(
    {
      organizationId: payload.organizationId,
      propertyId: branch.propertyId,
      customerId: customer.id,
      customerName: payload.customerName,
      customerPhone: payload.customerPhone,
      customerAddress: payload.customerAddress ?? null,
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
}

export { DEFAULT_COMPLEMENTS };
