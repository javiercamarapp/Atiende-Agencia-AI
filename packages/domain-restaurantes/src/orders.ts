// Port de prepareCreateOrder/createOrderCore/buscarProductosCore de
// restaurantes/supabase/functions/_shared/create-order-core.ts. El precio SIEMPRE se
// re-cotiza server-side contra el catálogo real de la sucursal — nunca se confía en
// un total mandado por el cliente/LLM (guardia anti-alucinación de precio, ver
// product-search.ts::resolveOrderItemsAgainstProducts).
import { createHash } from "node:crypto";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { OrderValidationError } from "./errors.ts";
import { tryNotifyCustomerOrderConfirmationEmail, tryNotifyStaffNewOrder } from "./order-notifications.ts";
import { normalizePhone, canonicalizeMexicanPhone } from "./phone.ts";
import { ADDRESS_MASK_MARKER, ADDRESS_OMITTED_MARKER, sanitizeInlineText, sanitizeNotes } from "./text-sanitize.ts";
import { formatUbicacionEntregaNota } from "./whatsapp/location.ts";
import { cerrarCicloDelCliente } from "./cliente-360/memoria.ts";
import { buildComplementNotes, buildDoubleSalsaLine, buildOrderQuoteFromProducts, DEFAULT_COMPLEMENTS, isTortillaChoice, MAX_PIEZAS_POR_RENGLON, mensajeCantidadInvalida } from "./order-quote.ts";
import { assignBranch } from "./branch-assignment.ts";
import { exigirPinSiPmSinZonas } from "./pin-reparto.ts";
import { aplicarReglasDeSucursal, normalizarCanal } from "./reglas-pedido.ts";
import { assertProgramacionDisponible, mensajeCerradoProgramado, parsearProgramadoPara, validarVentanaProgramacion, PROGRAMACION_MAXIMA_DIAS } from "./pedidos-programados.ts";
import { etiquetaHoraLocal } from "./horarios.ts";
import { applyPromotionToOrder, normalizePromotionCode, selectAutomaticPromotion } from "./promotions.ts";
import { extraerPackSize, matchesProductSearch, pesoDeProductoEnGramos, ordenarPorRelevancia, requiresAdultConfirmation, requiresTortillaChoice, resolveOrderItemsAgainstProducts, tokenizeForProductSearch, UUID_PATTERN } from "./product-search.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, CanalPedido, CreateOrderInput, DoubleSalsa, Order, OrderQuote, PersistedOrderItem, Promotion, ProductoEncontrado, PropinaPolitica, RequestedOrderItemInput } from "./types.ts";

/** Dinero a centavos (el redondeo comun de todo el modulo): una fraccion de centavo no existe. */
export function redondearACentavos(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Formato del CHECK de restaurantes.orders.customer_email (migrations/011_email_outbox_dispatch.sql): algo@dominio.tld —
// validación deliberadamente laxa (formato, no existencia real del buzón): suficiente para no encolar un correo con un valor
// obviamente inválido. Se escribe SIN backtracking ambiguo (cada etiqueta del dominio excluye el punto), así que es lineal
// (CodeQL js/polynomial-redos) y es igual o MÁS estricta que el CHECK: no admite etiquetas vacías ("a@b..c").
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function toProductoEncontrado(product: { id: string; name: string; description: string | null; categoryName: string | null; price: number; noDomicilio?: boolean }): ProductoEncontrado {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    packSize: extraerPackSize(product.name, product.description),
    requiresAdultConfirmation: requiresAdultConfirmation(product.name, product.categoryName),
    requiresTortilla: requiresTortillaChoice(product.name, product.description),
    categoryName: product.categoryName,
    ...(product.noDomicilio === true ? { noDomicilio: true } : {}),
  };
}

/** Categorias que NO traen las 9 salsas incluidas: un pedido solo de ellas no tiene salsa que duplicar (QA-PM-R2-reglas-14: 2 Coca-Cola con doble salsa
 * cobraban un Extra Salsa de $19). */
const CATEGORIAS_SIN_SALSA = /^(?:bebidas?|aguas frescas|refrescos|cervezas|licores y cocktails|postres|guarniciones extra)$/i;

/** La doble porcion de salsa exige al menos un platillo que traiga salsas incluidas. */
export function assertDobleSalsaAplica(products: readonly ProductoEncontrado[], orderedProductIds: readonly string[], doubleSalsas: readonly unknown[] | undefined): void {
  if (!doubleSalsas || doubleSalsas.length === 0) return;
  const ordenados = orderedProductIds.map((id) => products.find((p) => p.id === id)).filter((p): p is ProductoEncontrado => p !== undefined);
  if (ordenados.length > 0 && ordenados.every((p) => p.categoryName !== null && p.categoryName !== undefined && CATEGORIAS_SIN_SALSA.test(p.categoryName))) {
    throw new OrderValidationError("La doble porción de salsa solo aplica a platillos que ya traen salsas incluidas; este pedido es solo de bebidas o postres. Quite la doble salsa y vuelva a cotizar.");
  }
}

/** Búsqueda real de productos disponibles en una sucursal — port literal de
 * buscarProductosCore, incluyendo el fix real del 4-sep-2026 (match contra name,
 * description, categoría Y search_keywords, no solo name). */
export async function searchProducts(repo: RestaurantesRepository, args: { readonly propertyId: string; readonly query: string }): Promise<ProductoEncontrado[]> {
  const tokens = tokenizeForProductSearch(args.query);
  const catalog = await repo.listAvailableProductsForBranch(args.propertyId);
  const buscar = (ts: readonly string[]) => catalog.filter((p) => matchesProductSearch(ts, { name: p.name, description: p.description, categoryName: p.categoryName, searchKeywords: p.searchKeywords }));
  let encontrados = buscar(tokens);
  // "un cuarto de cochinita": el peso solo existe en los productos que se venden por kilo. Si con el peso no queda nada, se busca el producto sin el
  // peso (la lista vacia la lee el agente como "no tenemos eso", y la cochinita si existe, en ordenes). Con peso que SI coincide se conserva la exactitud.
  if (encontrados.length === 0 && tokens.some((t) => t.startsWith("peso:"))) {
    const sinPeso = tokens.filter((t) => !t.startsWith("peso:"));
    if (sinPeso.length > 0) encontrados = buscar(sinPeso);
  }
  // "heineken cero": el menu escribe "0.0".
  if (encontrados.length === 0 && tokens.includes("cero")) encontrados = buscar(tokens.map((t) => (t === "cero" ? "0.0" : t)));
  return ordenarPorRelevancia(tokens, encontrados, args.query).slice(0, 8).map(toProductoEncontrado);
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

/** Forma de la hora de recogida (ISO con zona). El reloj, el horario y el dia los valida `aplicarReglasDeSucursal`. */
export function validarTextoHoraRecogida(valor: unknown): void {
  if (typeof valor !== "string" || valor.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(valor) || Number.isNaN(Date.parse(valor))) {
    throw new OrderValidationError("La hora de recogida debe ser una fecha y hora ISO 8601 con zona horaria.");
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(valor)) throw new OrderValidationError("La hora de recogida debe incluir la zona horaria (por ejemplo -06:00).");
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
    invalidOptionalString(raw.promoCode, 40) ||
    invalidOptionalString(raw.colonia, 200)
  ) {
    throw new OrderValidationError("Uno o más campos exceden el tamaño permitido");
  }
  if (raw.idempotencyKey !== undefined && (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey.trim() || raw.idempotencyKey.length > 200)) {
    throw new OrderValidationError("idempotencyKey inválido");
  }
  if (raw.customerEmail !== undefined && raw.customerEmail !== null && raw.customerEmail.trim() !== "" && (typeof raw.customerEmail !== "string" || raw.customerEmail.trim().length > 320 || !EMAIL_RE.test(raw.customerEmail.trim()))) {
    throw new OrderValidationError("customerEmail inválido");
  }
  const canal = normalizarCanal(raw.canal);
  if (raw.propina !== undefined && (typeof raw.propina !== "number" || !Number.isFinite(raw.propina) || raw.propina < 0 || raw.propina > 100000)) {
    throw new OrderValidationError("La propina debe ser un monto en pesos mayor o igual a 0.");
  }
  if (
    raw.doubleSalsas !== undefined &&
    (!Array.isArray(raw.doubleSalsas) || raw.doubleSalsas.length > DEFAULT_COMPLEMENTS.length || raw.doubleSalsas.some((salsa) => !(DEFAULT_COMPLEMENTS as readonly string[]).includes(salsa)))
  ) {
    throw new OrderValidationError("La doble porción solo aplica a las salsas incluidas del menú.");
  }
  if (raw.efectivoCon !== undefined) {
    if (raw.paymentMethod !== "efectivo") throw new OrderValidationError("El monto con el que paga solo aplica a pedidos en efectivo.");
    if (typeof raw.efectivoCon !== "number" || !Number.isFinite(raw.efectivoCon) || raw.efectivoCon <= 0 || raw.efectivoCon > 100000) {
      throw new OrderValidationError("El monto con el que paga debe ser una cantidad en pesos mayor a 0.");
    }
  }
  if (raw.indicacionesAcceso !== undefined && (typeof raw.indicacionesAcceso !== "string" || raw.indicacionesAcceso.length > 1000)) {
    throw new OrderValidationError("Las indicaciones de acceso exceden el tamaño permitido");
  }
  const telefonoAlterno = raw.telefonoAlterno === undefined ? undefined : typeof raw.telefonoAlterno === "string" ? canonicalizeMexicanPhone(raw.telefonoAlterno) : null;
  if (telefonoAlterno === null) throw new OrderValidationError("El teléfono alterno debe tener exactamente 10 dígitos.");
  if (raw.horaRecogida !== undefined) {
    if (canal !== "recoger") throw new OrderValidationError("La hora de recogida solo aplica a pedidos para recoger.");
    validarTextoHoraRecogida(raw.horaRecogida);
  }
  // R-11: hora programada (ISO con zona, normalizada a UTC). La ventana y el horario se validan al cotizar.
  const programadoPara = raw.programadoPara === undefined ? undefined : parsearProgramadoPara(raw.programadoPara);
  const agentOrder = raw.source === "voice" || raw.source === "whatsapp";
  // Para recoger no hay direccion de entrega que exigir (la validacion de vacio va tras sanear, abajo).
  if (agentOrder && canal === "domicilio" && typeof raw.customerAddress !== "string") {
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
      (item.tortilla !== undefined && !isTortillaChoice(item.tortilla))
    ) {
      throw new OrderValidationError("Productos o cantidades inválidos");
    }
    const hasQuantity = item.quantity !== undefined;
    const hasRequested = item.requestedQuantity !== undefined;
    if (hasQuantity === hasRequested) throw new OrderValidationError("Productos o cantidades inválidos");
    const value = hasRequested ? item.requestedQuantity : item.quantity;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PIEZAS_POR_RENGLON) {
      throw new OrderValidationError(mensajeCantidadInvalida(value));
    }
  }

  // Saneo (defensa en profundidad): el nombre es una sola linea limpia; si queda vacio tras sanear, se rechaza.
  const cleanName = sanitizeInlineText(raw.customerName, 160);
  if (!cleanName) throw new OrderValidationError("branchSlug (o branchName), customerName y customerPhone son requeridos");
  const cleanAddress = raw.customerAddress === undefined ? undefined : sanitizeInlineText(raw.customerAddress);
  if (agentOrder && canal === "domicilio" && !cleanAddress) throw new OrderValidationError("La dirección completa de entrega es requerida");
  // La referencia parcial del prompt no es una direccion de entrega: si el modelo la copia tal cual, se rechaza.
  if (cleanAddress && (cleanAddress.includes(ADDRESS_MASK_MARKER) || cleanAddress.includes(ADDRESS_OMITTED_MARKER))) {
    throw new OrderValidationError("La dirección guardada solo es una referencia parcial: pide al cliente la dirección completa (o consúltala con buscar_cliente) y vuelve a intentar.");
  }

  return {
    ...raw,
    branchSlug: raw.branchSlug?.trim() || undefined,
    branchName: raw.branchName?.trim() || undefined,
    customerName: cleanName,
    customerPhone: voicePhone ?? normalizePhone(raw.customerPhone),
    customerAddress: cleanAddress,
    // La propina se guarda, se imprime y se manda a la comanda ya redondeada a centavos (10.555 -> 10.56): una sola cifra.
    ...(raw.propina !== undefined ? { propina: redondearACentavos(raw.propina) } : {}),
    notes: typeof raw.notes === "string" ? sanitizeNotes(raw.notes) || undefined : raw.notes,
    colonia: raw.colonia ? sanitizeInlineText(raw.colonia, 200) || undefined : undefined,
    ...(raw.efectivoCon !== undefined ? { efectivoCon: redondearACentavos(raw.efectivoCon) } : {}),
    indicacionesAcceso: raw.indicacionesAcceso ? sanitizeInlineText(raw.indicacionesAcceso, 200) || undefined : undefined,
    telefonoAlterno: telefonoAlterno ?? undefined,
    customerEmail: raw.customerEmail?.trim() ? raw.customerEmail.trim().toLowerCase() : undefined,
    promoCode: raw.promoCode?.trim() ? normalizePromotionCode(raw.promoCode) : undefined,
    programadoPara,
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
  /** Lineas de la comanda con la tortilla que eligio el cliente para un kilo de carne (ese renglon no exige tortilla y la descarta). */
  readonly tortillasDeKilo: readonly string[];
}

/** Tolerancia (minutos) para una hora de recogida "de ahora mismo": el cliente dice "paso en 5 minutos" y el modelo la redondea hacia atras. */
const TOLERANCIA_HORA_RECOGIDA_PASADA_MIN = 10;

/** Rechaza (con un mensaje que el agente puede leer y corregir) una hora de recogida ya pasada o mas alla de la ventana de programacion. */
export function validarHoraRecogida(horaRecogida: string, ahora: Date): void {
  const minutos = (Date.parse(horaRecogida) - ahora.getTime()) / 60_000;
  if (minutos < -TOLERANCIA_HORA_RECOGIDA_PASADA_MIN) {
    throw new OrderValidationError(
      "La hora de recogida ya pasó. Confirme con el cliente a qué hora de hoy pasará y mándela con la zona horaria de la sucursal (por ejemplo -06:00); si pasa de inmediato, omita hora_recogida.",
    );
  }
  if (minutos > PROGRAMACION_MAXIMA_DIAS * 24 * 60) {
    throw new OrderValidationError(`La hora de recogida debe caer dentro de los próximos ${PROGRAMACION_MAXIMA_DIAS} días. Confirme la fecha con el cliente.`);
  }
}

/** Cotiza un pedido completo contra el catálogo real, SIN persistir — usado también
 * por el modo de vista previa. Precio y disponibilidad siempre vienen de
 * branch_products, la fuente real por sucursal. */
export async function prepareCreateOrder(
  repo: RestaurantesRepository,
  rawInput: CreateOrderInput,
  /** `asOf`: instante contra el que se evaluan horario y promociones. SOLO para cargar pedidos historicos de una
   * demo (seed de volumen, R-20) con las mismas reglas del motor real; ningun flujo de produccion lo pasa. */
  options: { readonly asOf?: Date } = {},
): Promise<PreparedOrder> {
  const payload = validateCreateOrderPayload(rawInput);

  const branch = await repo.findBranch(payload.organizationId, { slug: payload.branchSlug, name: payload.branchName });
  if (!branch || branch.status !== "active") {
    throw new OrderValidationError(`Sucursal '${payload.branchSlug ?? payload.branchName}' no encontrada o inactiva`);
  }

  // R-11: pedido programado -- el horario y las promociones se evaluan en la hora ELEGIDA (no en este instante).
  const programado = payload.programadoPara ? new Date(payload.programadoPara) : null;
  if (programado) validarVentanaProgramacion(payload.programadoPara!, new Date());
  // QA R2 caos-04: la hora de recogida que elige el cliente no puede estar en el pasado ni fuera de la ventana de programacion
  // (un modelo que manda la fecha de ayer, o "Z" en lugar de -06:00, la corre horas atras y el pedido nacia ya vencido).
  if (payload.horaRecogida) validarHoraRecogida(payload.horaRecogida, options.asOf ?? new Date());
  const instanteDelPedido = programado ?? options.asOf ?? new Date();
  // Una hora de recogida y una hora programada distintas en el mismo pedido se contradicen (la comanda decia 14:00 y 20:00 a la vez).
  if (programado && payload.horaRecogida && Math.abs(Date.parse(payload.horaRecogida) - programado.getTime()) > 60_000) {
    throw new OrderValidationError("La hora de recogida y la hora programada son distintas. Use una sola: para recoger más tarde use programado_para con esa hora y no mande hora_recogida.");
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
  // QA-PM-R3-reglas-11: el kilo de carne ("Pastor — 1 kg") no exige tortilla, asi que `buildOrderQuoteFromProducts` la descarta; pero va CON tortillas y el cliente
  // elige cual ("de harina"). Esa eleccion viaja en una linea de las notas de la comanda (cocina la ve) en vez de perderse.
  const tortillasDeKilo: string[] = [];
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
      { adultConfirmed: payload.adultConfirmed || (!requestedPieces && !isAgentOrder), canal: normalizarCanal(payload.canal) },
    ).lines[0]!;

    if (!Number.isInteger(quote.quantity) || quote.quantity <= 0) {
      throw new OrderValidationError(`Cantidad inválida para ${product.name}`);
    }
    if (!quote.tortilla && inputItem.tortilla && isTortillaChoice(inputItem.tortilla) && pesoDeProductoEnGramos(product.name) !== null) {
      tortillasDeKilo.push(`Tortilla (${product.name}): ${inputItem.tortilla}.`);
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

  // Doble porcion de salsas: extra COBRADO (producto "Extra salsa" del catalogo, precio de catalogo).
  const doubleSalsaLine = buildDoubleSalsaLine(resolved.products, payload.doubleSalsas ?? []);
  assertDobleSalsaAplica(resolved.products, resolved.items.map((i) => i.productId), payload.doubleSalsas);
  if (doubleSalsaLine) {
    total = Math.round((total + doubleSalsaLine.lineTotal) * 100) / 100;
    orderItems.push({ id: doubleSalsaLine.productId, name: doubleSalsaLine.name, price: doubleSalsaLine.price, quantity: doubleSalsaLine.quantity });
  }

  // Modelo PM (migracion 023) -- reglas por sucursal: horario, pedido minimo por canal
  // (sobre el total de renglones ANTES de descuentos), cobertura de entrega y propina.
  // Opt-in: sin politica configurada no cambia nada.
  const reglas = await aplicarReglasDeSucursal(repo, {
    branch,
    canal: normalizarCanal(payload.canal),
    subtotal: total,
    colonia: payload.colonia,
    pinEnEstaSucursal: pinEnSucursal(repo, branch, payload.organizationId, payload.ubicacion),
    paymentMethod: payload.paymentMethod,
    propina: payload.propina,
    source: payload.source,
    ...(programado
      ? { now: programado, exigirAbierto: true, mensajeCerrado: mensajeCerradoProgramado(branch.name, payload.programadoPara!) }
      : options.asOf
        ? { now: options.asOf }
        : {}),
    ...(payload.horaRecogida && !programado ? { horaRecogida: payload.horaRecogida } : {}),
  });
  // CR12: PM sin zonas cargadas no acepta "cualquier colonia" a domicilio: exige el pin (asigna por distancia) o una persona.
  await exigirPinSiPmSinZonas(repo, { branch, canal: normalizarCanal(payload.canal), source: payload.source, ubicacion: payload.ubicacion });

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
    // FASE 3 (producto) — hasta esta fase, la vigencia por día/hora de una
    // promoción (`daysOfWeek`/`startTime`/`endTime`) se evaluaba con
    // `now.getDay()`/`now.getHours()`/`now.getMinutes()`, componentes UTC del
    // reloj del PROCESO en Vercel — nunca la hora local del negocio (ver el
    // comentario de cabecera de `promotions.ts::assertPromotionApplicable`).
    // `findBranchZonaHoraria` es una consulta AISLADA (no reusa `findBranch` /
    // el `branch` ya resuelto arriba) para no ensanchar el tipo `Branch`
    // público, usado en muchos otros call-sites — ver el comentario de
    // cabecera de la migración 022.
    const zonaHoraria = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria);
    const applied = applyPromotionToOrder({
      promotion,
      orderTotal: total,
      items: orderItems,
      canal: normalizarCanal(payload.canal),
      now: instanteDelPedido,
      zonaHoraria,
      ...(reglas.diaNegocio !== null ? { diaNegocio: reglas.diaNegocio } : {}),
      propertyId: branch.propertyId,
    });
    total = applied.total;
    discount = applied.discount;
    appliedPromotion = promotion;
  } else {
    // PM PR-4: promociones AUTOMATICAS por dia y canal (sin codigo). Corre sobre el mismo total/renglones ya
    // cotizados; una sola por pedido; las de recoger nunca aplican a domicilio (ver selectAutomaticPromotion).
    // Contra la base sin migrar `listAutoApplyPromotions` devuelve [] (SAVEPOINT): el pedido sigue igual.
    const zonaHoraria = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria);
    const auto = selectAutomaticPromotion({
      promotions: await repo.listAutoApplyPromotions(payload.organizationId),
      orderTotal: total,
      items: orderItems,
      canal: normalizarCanal(payload.canal),
      now: instanteDelPedido,
      zonaHoraria,
      ...(reglas.diaNegocio !== null ? { diaNegocio: reglas.diaNegocio } : {}),
      propertyId: branch.propertyId,
    });
    if (auto.applied) {
      total = auto.applied.total;
      discount = auto.applied.discount;
      appliedPromotion = auto.applied.promotion;
    }
  }

  // La propina no tiene tope en SQL y el de $100,000 de la validacion es absurdo para un pedido de $252: se rechaza una propina mayor que el
  // total a pagar (el modelo la lee como un posible error de captura y la confirma con el cliente).
  if (payload.propina !== undefined && redondearACentavos(payload.propina) > total) {
    throw new OrderValidationError("La propina no puede ser mayor que el total del pedido. Confirme el monto con el cliente antes de registrarla.");
  }

  return { payload, branch, orderItems, total, containsAlcohol, appliedPromotion, discount, tortillasDeKilo };
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
export async function createOrder(
  repo: RestaurantesRepository,
  rawInput: CreateOrderInput,
  /** `beforePersist`: gancho que ve el pedido YA cotizado contra el catalogo vigente y puede rechazarlo (lanzando)
   * antes de escribir nada. Lo usa la maquina de estados del pedido para exigir que los precios sigan siendo los
   * que el cliente confirmo. */
  options: {
    readonly beforePersist?: (prepared: PreparedOrder) => void | Promise<void>;
    /** `retener`: gancho que corre justo despues de persistir el pedido (misma transaccion). Si devuelve `true` el pedido quedo RETENIDO (p. ej. pedido grande
     * `por_aprobar`): no sale el aviso "nuevo pedido" ni el correo de confirmacion (todavia no esta confirmado) y el pedido devuelto lleva ese estado. Si lanza,
     * la transaccion (o el SAVEPOINT de la herramienta) revierte tambien el pedido: nunca queda un pedido grande en `pending` rumbo a cocina. */
    readonly retener?: (order: Order, prepared: PreparedOrder) => Promise<boolean>;
  } = {},
): Promise<Order> {
  const prepared = await prepareCreateOrder(repo, rawInput);
  await options.beforePersist?.(prepared);
  const { payload, branch, orderItems, total, containsAlcohol, appliedPromotion, discount, tortillasDeKilo } = prepared;
  // R-11: contra una base sin la migracion 034 el pedido programado se rechaza (503) en vez de crearse inmediato.
  if (payload.programadoPara) await assertProgramacionDisponible(repo);

  const customer = await repo.upsertCustomer(payload.organizationId, payload.customerPhone, payload.customerName);
  if (payload.customerAddress) await repo.addCustomerAddressIfNew(customer.id, payload.customerAddress, payload.organizationId);

  const itemsOrdenados = [...orderItems].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const complementNotes = buildComplementNotes(payload.notes, [...new Set(payload.requestedComplements ?? [])].sort(), [...new Set(payload.omitDefaultComplements ?? [])].sort(), payload.basicComplements);
  const notesWithAlcohol = containsAlcohol ? [complementNotes, "Recepción de alcohol: mayoría de edad confirmada por el cliente."].join("\n") : complementNotes;
  // Fase 11 — el descuento real ya está restado de `total` (ver prepareCreateOrder);
  // esta nota es solo auditoría legible por el staff en el panel de pedidos, nunca
  // la fuente de verdad del descuento (eso es `total` + `appliedPromotion`).
  const notesWithPromotion = appliedPromotion ? [notesWithAlcohol, `Promoción aplicada: ${appliedPromotion.code} (-$${discount.toFixed(2)}).`].join("\n") : notesWithAlcohol;
  // Canal y propina viajan en las notas (no hay columnas dedicadas en `orders`): solo se
  // agregan cuando el caller los manda, para no alterar el dedupe de pedidos historicos.
  const canalLines: string[] = [];
  if (payload.canal) canalLines.push(payload.canal === "recoger" ? "Canal: recoger en sucursal." : "Canal: domicilio.");
  if (payload.propina !== undefined && payload.propina > 0) canalLines.push(`Propina: $${payload.propina.toFixed(2)} (no incluida en el total).`);
  // Pago y acceso: lineas del servidor (sin columna dedicada). `efectivoCon` se valida contra el total YA calculado: pagar con menos que el total no es un pedido valido.
  if (payload.efectivoCon !== undefined) {
    if (payload.efectivoCon < total) throw new OrderValidationError(`El monto con el que paga ($${payload.efectivoCon.toFixed(2)}) es menor al total del pedido ($${total.toFixed(2)}): pregúntele con cuánto va a pagar.`);
    canalLines.push(`Paga con: $${payload.efectivoCon.toFixed(2)} (cambio: $${(Math.round((payload.efectivoCon - total) * 100) / 100).toFixed(2)}).`);
  }
  if (payload.llevarTerminal === true && payload.paymentMethod === "tarjeta" && (payload.canal ?? "domicilio") === "domicilio") canalLines.push("Llevar terminal.");
  if (payload.indicacionesAcceso && (payload.canal ?? "domicilio") === "domicilio") canalLines.push(`Indicaciones de acceso: ${payload.indicacionesAcceso}.`);
  if (payload.telefonoAlterno) canalLines.push(`Teléfono alterno: ${payload.telefonoAlterno}.`);
  // Destino de entrega (pin de WhatsApp o link de Maps) para el repartidor; solo a domicilio (recoger no lo usa).
  if (payload.ubicacionEntrega && (payload.canal ?? "domicilio") === "domicilio") canalLines.push(formatUbicacionEntregaNota(payload.ubicacionEntrega));
  canalLines.push(...tortillasDeKilo);
  if (payload.horaRecogida) canalLines.push(`Hora de recogida: ${payload.horaRecogida}.`);
  if (payload.programadoPara) {
    const zona = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria);
    canalLines.push(`Pedido programado para: ${etiquetaHoraLocal(new Date(payload.programadoPara), zona)}.`);
  }
  const finalNotes = canalLines.length > 0 ? [notesWithPromotion, ...canalLines].join("\n") : notesWithPromotion;

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
      ...(payload.basicComplements ? { basic_complements: [...payload.basicComplements].sort() } : {}),
      // Solo entra al hash cuando hay doble porcion: el hash de pedidos sin ella no cambia.
      ...(payload.doubleSalsas && payload.doubleSalsas.length > 0 ? { double_salsas: [...new Set(payload.doubleSalsas)].sort() } : {}),
      // Solo entra al hash cuando el pedido es programado: el hash de pedidos normales no cambia.
      ...(payload.programadoPara ? { programado_para: payload.programadoPara } : {}),
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
      // Migracion 031: columnas de canal/propina/hora de recogida (la base vieja las ignora).
      canal: payload.canal ? normalizarCanal(payload.canal) : null,
      propina: payload.propina !== undefined && payload.propina > 0 ? payload.propina : null,
      horaRecogida: payload.horaRecogida ?? null,
      // Migracion 034: con valor, create_order_idempotent lo crea en `programado` (ya verificado arriba).
      programadoPara: payload.programadoPara ?? null,
    },
    dedupeFingerprint,
    idempotencyKey,
  );

  // Fase 9 — "nuevo pedido entrante" al staff (ver order-notifications.ts, gap real
  // verificado: `createOrder` nunca disparaba ningún aviso). Best-effort e
  // idempotente por (organizationId, orderId, eventType) -- un reintento real de
  // create_order_idempotent que devuelve el MISMO pedido (misma idempotencyKey o
  // dedupeFingerprint) nunca duplica la notificación.
  const retenido = options.retener ? await options.retener(order, prepared) : false;
  if (!retenido) await tryNotifyStaffNewOrder(repo, order);

  // Fase de correo — confirmación de pedido por correo real, best-effort e
  // idempotente por (organizationId, channel, dedupeKey) igual que la línea de
  // arriba: cuando el cliente no dejó correo (voz/WhatsApp, o web sin llenarlo),
  // `notifyCustomerOrderConfirmationEmailCore` simplemente no encola nada — ver
  // order-notifications.ts.
  if (!retenido) await tryNotifyCustomerOrderConfirmationEmail(repo, order);

  // Cliente 360 (migracion 049): cierre automatico del ciclo con el cliente. Domicilio (alta o "usado otra vez") y gustos
  // se actualizan a partir de lo que el cliente CONFIRMO en este pedido; idempotente por pedido (un reintento que devuelve
  // el mismo pedido no cuenta dos veces) y best-effort con SAVEPOINT: nunca revierte un pedido ya creado.
  await cerrarCicloDelCliente(repo, order, payload);

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
  // Nota: un pedido RETENIDO (`por_aprobar`) tambien consume el uso de la promocion: si la sucursal lo rechaza despues, el uso queda consumido (no se devuelve).
  if (appliedPromotion) {
    await tryIncrementPromotionUses(repo, payload.organizationId, appliedPromotion.id);
  }
  return retenido ? { ...order, status: "por_aprobar" } : order;
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
/** QA-PM-R3-whatsapp-05: ¿la sucursal mas cercana al pin que compartio el cliente es esta? (solo se consulta si hace falta: colonia no reconocida). */
function pinEnSucursal(repo: RestaurantesRepository, branch: Branch, organizationId: string, ubicacion: { readonly lat: number; readonly lng: number } | undefined): (() => Promise<boolean>) | undefined {
  if (!ubicacion) return undefined;
  return async () => {
    const asignacion = await assignBranch(repo, { organizationId, lat: ubicacion.lat, lng: ubicacion.lng });
    return asignacion.estado === "asignada" && asignacion.branchSlug === branch.slug;
  };
}

export async function quoteOrder(
  repo: RestaurantesRepository,
  args: {
    readonly organizationId: string;
    readonly branchSlug: string;
    readonly items: readonly RequestedOrderItemInput[];
    readonly adultConfirmed?: boolean;
    /** Modelo PM: canal del pedido (default "domicilio"), colonia de entrega y forma de pago
     * (solo para decidir si corresponde preguntar propina). */
    readonly canal?: CanalPedido;
    readonly colonia?: string;
    /** Pin compartido por el cliente y canal de origen (CR12, `pin-reparto.ts`); solo los pone el servidor. */
    readonly ubicacion?: { readonly lat: number; readonly lng: number };
    readonly source?: "web" | "voice" | "whatsapp" | "admin";
    readonly paymentMethod?: "efectivo" | "tarjeta";
    /** Doble porcion de salsas (extra cobrado, ver `buildDoubleSalsaLine`). */
    readonly doubleSalsas?: readonly DoubleSalsa[];
    /** R-11: hora programada (ISO con zona). Se valida con las MISMAS reglas que `createOrder`: ventana
     * (anticipacion minima/maxima), horario de la sucursal en esa hora y zona horaria de la sucursal. */
    readonly programadoPara?: string;
    /** QA R2 features-07: codigo de promocion (p. ej. el GRACIAS-XXXX de una compensacion) que el cliente dicta por WhatsApp o voz.
     * Cuando viene, REEMPLAZA a la promocion automatica (igual que en `createOrder`) y un codigo invalido lanza `PromotionError`. */
    readonly promoCode?: string;
    /** Solo canal "recoger": hora a la que pasara el cliente (ISO con zona). Se valida con el reloj del servidor, igual que al crear. */
    readonly horaRecogida?: string;
  },
): Promise<OrderQuote & QuotePolicyInfo & QuotePromotionInfo> {
  const branch = await repo.findBranch(args.organizationId, { slug: args.branchSlug });
  if (!branch || branch.status !== "active") {
    throw new OrderValidationError(`Sucursal '${args.branchSlug}' no encontrada o inactiva`);
  }
  const canal = normalizarCanal(args.canal);
  if (args.horaRecogida !== undefined) {
    if (canal !== "recoger") throw new OrderValidationError("La hora de recogida solo aplica a pedidos para recoger.");
    validarTextoHoraRecogida(args.horaRecogida);
  }
  // R-11: cotizar un pedido programado aplica la misma ventana y el mismo horario que crearlo, para que el
  // cliente no confirme un resumen que despues se rechazaria. Contra una base sin la migracion 034 se rechaza.
  const programadoPara = args.programadoPara === undefined ? undefined : parsearProgramadoPara(args.programadoPara);
  if (programadoPara) {
    validarVentanaProgramacion(programadoPara, new Date());
    await assertProgramacionDisponible(repo);
  }
  const instante = programadoPara ? new Date(programadoPara) : null;
  const resolved = await resolveBranchOrderItems(repo, branch.propertyId, args.items);
  const baseQuote = buildOrderQuoteFromProducts(resolved.items, resolved.products, { adultConfirmed: args.adultConfirmed, canal });
  // Misma validacion que al crear: una doble salsa fuera del catalogo (R07) se cotizaba y despues crear_pedido la rechazaba.
  if (args.doubleSalsas !== undefined && (!Array.isArray(args.doubleSalsas) || args.doubleSalsas.length > DEFAULT_COMPLEMENTS.length || args.doubleSalsas.some((salsa) => !(DEFAULT_COMPLEMENTS as readonly string[]).includes(salsa)))) {
    throw new OrderValidationError("La doble porción solo aplica a las salsas incluidas del menú.");
  }
  const doubleSalsaLine = buildDoubleSalsaLine(resolved.products, args.doubleSalsas ?? []);
  assertDobleSalsaAplica(resolved.products, resolved.items.map((i) => i.productId), args.doubleSalsas);
  const quote: OrderQuote = doubleSalsaLine
    ? { ...baseQuote, lines: [...baseQuote.lines, doubleSalsaLine], total: Math.round((baseQuote.total + doubleSalsaLine.lineTotal) * 100) / 100 }
    : baseQuote;
  const reglas = await aplicarReglasDeSucursal(repo, {
    branch,
    canal,
    subtotal: quote.total,
    colonia: args.colonia,
    pinEnEstaSucursal: pinEnSucursal(repo, branch, args.organizationId, args.ubicacion),
    paymentMethod: args.paymentMethod,
    ...(instante ? { now: instante, exigirAbierto: true, mensajeCerrado: mensajeCerradoProgramado(branch.name, programadoPara!) } : {}),
    ...(args.horaRecogida && !instante && canal === "recoger" ? { horaRecogida: args.horaRecogida } : {}),
  });
  await exigirPinSiPmSinZonas(repo, { branch, canal, source: args.source, ubicacion: args.ubicacion });

  // PM PR-4: promociones automaticas por dia y canal. `total` pasa a ser el TOTAL A PAGAR (ya con el
  // descuento) y `subtotal` conserva el de renglones; sin promocion aplicada nada cambia. Las promociones
  // que ya valen hoy pero a las que el pedido aun no llega se devuelven como sugerencias para que el agente
  // las ofrezca (p. ej. el martes: "con los nachos de pastor van 2 aguas de cortesia, ¿cuales?").
  const zonaHoraria = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria);
  const itemsPromo = quote.lines.map((line) => ({ id: line.productId, name: line.name, price: line.price, quantity: line.quantity }));
  const codigo = args.promoCode?.trim() ? normalizePromotionCode(args.promoCode) : null;
  const auto = codigo
    ? await cotizarConCodigo(repo, { organizationId: args.organizationId, codigo, orderTotal: quote.total, items: itemsPromo, canal, now: instante ?? new Date(), zonaHoraria, diaNegocio: reglas.diaNegocio, propertyId: branch.propertyId })
    : selectAutomaticPromotion({
        promotions: await repo.listAutoApplyPromotions(args.organizationId),
        orderTotal: quote.total,
        items: itemsPromo,
        canal,
        now: instante ?? new Date(),
        zonaHoraria,
        ...(reglas.diaNegocio !== null ? { diaNegocio: reglas.diaNegocio } : {}),
        propertyId: branch.propertyId,
      });
  const descuento = auto.applied?.discount ?? 0;
  const nombreDeProducto = (id: string) => resolved.products.find((p) => p.id === id)?.name ?? null;
  return {
    ...quote,
    subtotal: quote.total,
    descuento,
    total: auto.applied ? auto.applied.total : quote.total,
    promocionAplicada: auto.applied
      ? { code: auto.applied.promotion.code, name: auto.applied.promotion.name, type: auto.applied.promotion.type, descuento }
      : null,
    promocionesSugeridas: auto.suggestions.map(({ promotion, motivo }) => ({
      code: promotion.code,
      name: promotion.name,
      motivo,
      mensaje:
        promotion.type === "cortesia"
          ? `Hoy, para recoger, "${promotion.name}": por cada producto de la promoción van ${promotion.courtesyQuantity ?? 0} pieza(s) de cortesía a elegir por el cliente (sin costo). Ofrézcalo y, si acepta, agregue esas piezas como renglones del pedido y vuelva a cotizar.`
          : `Hoy, para recoger, aplica "${promotion.name}"${promotion.description ? `: ${promotion.description}` : ""}. Con este pedido todavía no se cumple: ofrézcalo y, si acepta, agregue los productos y vuelva a cotizar.`,
      ...(promotion.type === "cortesia" && promotion.courtesyProductIds
        ? {
            opcionesCortesia: promotion.courtesyProductIds
              .map((productId) => ({ productId, name: nombreDeProducto(productId) }))
              .filter((o): o is { productId: string; name: string } => o.name !== null),
            cortesiaPorUnidad: promotion.courtesyQuantity ?? 0,
          }
        : {}),
    })),
    canal,
    pedidoMinimo: reglas.pedidoMinimo,
    propinaPolitica: reglas.policy.propinaPolitica,
    preguntarPropina: reglas.preguntarPropina,
    abiertoAhora: reglas.apertura ? reglas.apertura.abierto : null,
    cierraA: reglas.apertura?.cierraA ?? null,
    ...(programadoPara ? { programadoPara } : {}),
  };
}

/** Cotiza con un CODIGO que dicto el cliente (misma validacion y calculo que `createOrder`): devuelve la forma de `selectAutomaticPromotion`
 * con la promocion aplicada y sin sugerencias. Un codigo inexistente o que no vale hoy/en este canal lanza `OrderValidationError`. */
async function cotizarConCodigo(
  repo: RestaurantesRepository,
  a: {
    readonly organizationId: string;
    readonly codigo: string;
    readonly orderTotal: number;
    readonly items: readonly PersistedOrderItem[];
    readonly canal: CanalPedido;
    readonly now: Date;
    readonly zonaHoraria: string;
    readonly diaNegocio: number | null;
    readonly propertyId: string;
  },
): Promise<ReturnType<typeof selectAutomaticPromotion>> {
  const promotion = await repo.findPromotionByCode(a.organizationId, a.codigo);
  if (!promotion) throw new OrderValidationError(`El código "${a.codigo}" no existe.`);
  const applied = applyPromotionToOrder({
    promotion,
    orderTotal: a.orderTotal,
    items: a.items,
    canal: a.canal,
    now: a.now,
    zonaHoraria: a.zonaHoraria,
    ...(a.diaNegocio !== null ? { diaNegocio: a.diaNegocio } : {}),
    propertyId: a.propertyId,
  });
  return { applied: { promotion, total: applied.total, discount: applied.discount }, suggestions: [] };
}

/** Promociones automaticas que acompanan a una cotizacion (PM PR-4). */
export interface QuotePromotionInfo {
  /** Suma de renglones ANTES de descuento. `total` (de `OrderQuote`) es el total A PAGAR. */
  readonly subtotal: number;
  readonly descuento: number;
  readonly promocionAplicada: { readonly code: string; readonly name: string; readonly type: Promotion["type"]; readonly descuento: number } | null;
  readonly promocionesSugeridas: readonly {
    readonly code: string;
    readonly name: string;
    readonly motivo: "faltan_productos" | "falta_elegir_cortesia";
    readonly mensaje: string;
    readonly opcionesCortesia?: readonly { readonly productId: string; readonly name: string }[];
    readonly cortesiaPorUnidad?: number;
  }[];
}

/** Informacion de politica de sucursal que acompana a una cotizacion (modelo PM). */
export interface QuotePolicyInfo {
  readonly canal: CanalPedido;
  /** Minimo que aplica a este canal (ya cumplido: si no se cumpliera, `quoteOrder` lanza). */
  readonly pedidoMinimo: number | null;
  readonly propinaPolitica: PropinaPolitica | null;
  /** true si, dada la forma de pago conocida hasta ahora, corresponde preguntar propina. */
  readonly preguntarPropina: boolean;
  /** null = la sucursal no tiene horario configurado. */
  readonly abiertoAhora: boolean | null;
  readonly cierraA: string | null;
  /** R-11: hora programada ya validada (ISO UTC); ausente en un pedido inmediato. */
  readonly programadoPara?: string;
}
