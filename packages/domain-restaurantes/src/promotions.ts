// Fase 11 — motor real de promociones/marketing (ver diseño del gap: "Promociones/
// marketing -- esquema y endpoints"). Verificado contra el original
// (restaurantes/supabase/migrations/20251204004242_remix_migration_from_pg_dump.sql +
// supabase/functions/_shared/whatsapp-agent-core.ts): `public.promos` del origen es
// un banner puramente informativo (title/description/image_url/discount_text
// LIBRE/is_active/display_order) sin ninguna aplicación real a un pedido —
// `orders` del origen no tiene columna de descuento/promo_id, y discount_text
// ("2x1", "20% off") nunca se calcula, solo se muestra; el agente de WhatsApp solo
// lo MENCIONA. Este archivo es deliberadamente nuevo respecto al origen — no un
// port de una regla de negocio verificada — porque el gap real pedía la aplicación
// real de una promoción al total de un pedido, que el original nunca tuvo.
//
// Principio de reuso (mismo que exige el gap): este módulo NUNCA recalcula precios
// de línea — compone sobre el `total` que ya produjo el motor de cotización real
// (order-quote.ts::buildOrderQuoteFromProducts, vía orders.ts::prepareCreateOrder).
// Cero duplicación de la lógica de precio.
//
// Reglas de negocio elegidas (documentadas aquí porque el original no tiene
// ninguna regla real que verificar, ver comentario de cabecera de types.ts):
// - UNA sola promoción por pedido — no hay evidencia de combinabilidad en el
//   origen, así que no se inventa una regla de "sí se pueden combinar".
// - `maxUses` es un tope real y agregado (organization-wide), reforzado con un
//   UPDATE atómico en Postgres (ver postgres-repository.ts::incrementPromotionUses)
//   para que dos pedidos casi-simultáneos con el mismo código nunca lo rebasen.
import { PromotionError } from "./errors.ts";
import type { CanalPedido, PersistedOrderItem, Promotion } from "./types.ts";

export const PROMOTION_CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;

/** Normaliza un código de promoción tal como lo captura el staff o lo escribe un
 * cliente — mayúsculas, sin espacios al margen. Nunca decide validez, solo forma
 * canónica (mismo criterio que `normalizePhone`/slugs de admin-catalog.ts). */
export function normalizePromotionCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function minutesSinceMidnight(hhmm: string): number {
  const parts = hhmm.split(":");
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}

const WEEKDAY_SHORT_TO_JS_DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Cache por zona horaria, mismo criterio que
 * `@atiende/core-tenancy::fecha-negocio.ts::formatterHoy` -- construir un
 * `Intl.DateTimeFormat` no es gratis y esto corre en el camino caliente de
 * crear un pedido. */
const CACHE_FORMATTER_DIA_HORA: Map<string, Intl.DateTimeFormat> = new Map();

function formatterDiaHora(zonaHoraria: string): Intl.DateTimeFormat {
  let formatter = CACHE_FORMATTER_DIA_HORA.get(zonaHoraria);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zonaHoraria, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    CACHE_FORMATTER_DIA_HORA.set(zonaHoraria, formatter);
  }
  return formatter;
}

/**
 * FASE 3 (producto) -- bug real corregido (revisión de esta fase): `now.getDay()`/
 * `now.getHours()`/`now.getMinutes()` leen los componentes del reloj del PROCESO,
 * NUNCA la hora local del negocio -- en Vercel (`TZ=UTC`) una promoción "viernes
 * 18:00-23:00" evaluaba viernes 18:00-23:00 UTC (sábado 00:00-05:00 en
 * America/Mexico_City), hasta 6 horas y potencialmente un día distinto del real.
 * Este helper reemplaza esos 3 accesores por el día/hora REAL en la zona horaria
 * de la property, vía `Intl.DateTimeFormat` (mismo patrón que
 * `@atiende/core-tenancy::hoyFechaNegocio`). `% 24` en la hora es defensivo: la
 * mayoría de los motores ICU dan "00" a medianoche con `hour12: false`, pero el
 * estándar permite "24" -- verificado en Node/V8 (ICU) que da "00", nunca "24",
 * antes de escribir este helper; el `% 24` no cambia ese caso y blinda contra un
 * motor/versión de ICU que sí diera "24".
 */
function partesDeHoyEnZona(now: Date, zonaHoraria: string): { readonly dayOfWeek: number; readonly minutesSinceMidnight: number } {
  const parts = formatterDiaHora(zonaHoraria).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { dayOfWeek: WEEKDAY_SHORT_TO_JS_DAY[weekday] ?? 0, minutesSinceMidnight: hour * 60 + minute };
}

/**
 * Valida que una promoción sea aplicable AHORA, contra un total de pedido ya
 * calculado por el motor real — activa, dentro de starts_at/ends_at, dentro de
 * days_of_week si se definió, dentro de start_time/end_time si se definió
 * (soporta ventana que cruza medianoche, ej. 22:00-02:00), bajo max_uses si se
 * definió, y el total alcanza min_order_total si se definió. Nunca lanza
 * silenciosamente: cada rechazo nombra la razón real, para que la ruta HTTP (o el
 * agente de voz/WhatsApp) se lo explique al cliente en vez de un "código
 * inválido" genérico.
 *
 * `zonaHoraria` es la zona YA resuelta de la property (ver
 * `@atiende/core-tenancy::resolverZonaHorariaNegocio`) -- `startsAt`/`endsAt` se
 * siguen comparando por instante absoluto (`.getTime()`, sin bug de zona
 * horaria: un instante UTC es el mismo instante en cualquier zona); solo
 * `daysOfWeek`/`startTime`/`endTime` (hora de PARED del negocio) necesitan la
 * zona real.
 */
export function assertPromotionApplicable(
  promotion: Promotion,
  orderTotal: number,
  now: Date,
  zonaHoraria: string,
  canal?: CanalPedido,
  /** Dia de NEGOCIO (0-6) cuando difiere del dia calendario: la cola de un turno que cruza la medianoche
   * (00:30 del martes dentro del turno 18:00-01:00 del lunes) cuenta como lunes. Sin valor = dia calendario. */
  diaNegocio?: number,
  /** Sucursal del pedido (`core.property.id`). Una promocion con alcance por sucursal (`propertyIds`, migracion 038) solo
   * vale en esas sucursales: sin sucursal del pedido NO se puede verificar y la promocion no aplica (cierra por defecto,
   * igual que el canal). Sin alcance (`null`/ausente) vale en todas, como antes. */
  propertyId?: string,
): void {
  if (!promotion.isActive) {
    throw new PromotionError(`El código "${promotion.code}" ya no está activo.`);
  }
  if (promotion.startsAt && now.getTime() < new Date(promotion.startsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" todavía no está vigente.`);
  }
  if (promotion.endsAt && now.getTime() > new Date(promotion.endsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" ya expiró.`);
  }
  const { dayOfWeek: diaCalendario, minutesSinceMidnight: nowMinutes } = partesDeHoyEnZona(now, zonaHoraria);
  const dayOfWeek = diaNegocio ?? diaCalendario;
  if (promotion.daysOfWeek && promotion.daysOfWeek.length > 0 && !promotion.daysOfWeek.includes(dayOfWeek)) {
    throw new PromotionError(`El código "${promotion.code}" no aplica el día de hoy.`);
  }
  if (promotion.startTime !== null || promotion.endTime !== null) {
    const startMinutes = minutesSinceMidnight(promotion.startTime ?? "00:00");
    const endMinutes = minutesSinceMidnight(promotion.endTime ?? "23:59");
    const withinWindow = startMinutes <= endMinutes ? nowMinutes >= startMinutes && nowMinutes <= endMinutes : nowMinutes >= startMinutes || nowMinutes <= endMinutes;
    if (!withinWindow) {
      throw new PromotionError(`El código "${promotion.code}" solo aplica de ${promotion.startTime ?? "00:00"} a ${promotion.endTime ?? "23:59"}.`);
    }
  }
  // Restriccion por canal (migracion 027): vacio/null = todos los canales. Sin `canal` del pedido no
  // se puede verificar, asi que una promocion restringida NO aplica (cierra por defecto).
  if (promotion.channels && promotion.channels.length > 0 && (canal === undefined || !promotion.channels.includes(canal))) {
    throw new PromotionError(`El código "${promotion.code}" no aplica a pedidos ${canal === "domicilio" ? "a domicilio" : canal === "recoger" ? "para recoger" : "de este tipo"}.`);
  }
  if (promotion.propertyIds != null && (propertyId === undefined || !promotion.propertyIds.includes(propertyId))) {
    throw new PromotionError(`El código "${promotion.code}" no aplica en esta sucursal.`);
  }
  if (promotion.maxUses !== null && promotion.timesUsed >= promotion.maxUses) {
    throw new PromotionError(`El código "${promotion.code}" ya alcanzó su límite de usos.`);
  }
  if (promotion.minOrderTotal !== null && orderTotal < promotion.minOrderTotal) {
    throw new PromotionError(`El código "${promotion.code}" requiere un pedido mínimo de $${promotion.minOrderTotal.toFixed(2)}.`);
  }
}

/** Calcula el descuento real — nunca negativo, nunca mayor al total del pedido
 * (un fijo mayor al total nunca deja un pedido en negativo), redondeado a
 * centavos con el mismo criterio que `buildOrderQuoteFromProducts`. */
export function computePromotionDiscount(promotion: Promotion, orderTotal: number): number {
  const raw = promotion.type === "percentage" ? orderTotal * (promotion.value / 100) : promotion.value;
  return Math.round(Math.min(Math.max(raw, 0), orderTotal) * 100) / 100;
}

/**
 * Aplica una promoción al total YA calculado por el motor de pedidos real (ver
 * orders.ts::prepareCreateOrder) — valida vigencia (`assertPromotionApplicable`,
 * lanza `PromotionError` si no aplica) y devuelve el nuevo total + el descuento
 * real. Nunca toca renglones/precios de producto. `zonaHoraria`: ver
 * `assertPromotionApplicable`.
 */
export function applyPromotionToOrderTotal(orderTotal: number, promotion: Promotion, now: Date, zonaHoraria: string): { readonly total: number; readonly discount: number } {
  // Un 2x1 necesita los renglones del pedido: usa `applyPromotionToOrder`.
  if (promotion.type === "bogo") throw new PromotionError(`El código "${promotion.code}" es 2x1 y requiere los renglones del pedido.`);
  if (promotion.type === "cortesia") throw new PromotionError(`El código "${promotion.code}" es un combo de cortesía y requiere los renglones del pedido.`);
  assertPromotionApplicable(promotion, orderTotal, now, zonaHoraria);
  const discount = computePromotionDiscount(promotion, orderTotal);
  return { total: Math.round((orderTotal - discount) * 100) / 100, discount };
}

/**
 * Descuento de un 2x1 sobre los renglones del pedido: cada renglon cuenta `quantity` unidades al
 * precio de linea; entre las unidades ELEGIBLES (todas si `productIds` es null, o solo las de esos
 * productos) se agrupan de dos en dos del mas caro al mas barato y la mas barata de cada par va
 * gratis -- o sea gratis `floor(n / 2)` unidades, las `floor(n / 2)` mas baratas. Con un solo
 * producto elegible es el 2x1 clasico (3 piezas => 1 gratis; 4 => 2). Nunca toca los precios de
 * linea, solo calcula el monto a restar.
 */
export function computeBogoDiscount(promotion: Promotion, items: readonly PersistedOrderItem[]): number {
  const ids = promotion.productIds && promotion.productIds.length > 0 ? new Set(promotion.productIds) : null;
  const unitPrices: number[] = [];
  for (const item of items) {
    if (ids && !ids.has(item.id)) continue;
    for (let i = 0; i < item.quantity; i += 1) unitPrices.push(item.price);
  }
  unitPrices.sort((a, b) => b - a);
  const free = Math.floor(unitPrices.length / 2);
  let discount = 0;
  for (const price of unitPrices.slice(unitPrices.length - free)) discount += price;
  return Math.round(discount * 100) / 100;
}

/**
 * Aplica una promocion al pedido real (renglones + canal): valida vigencia y canal
 * (`assertPromotionApplicable`) y calcula el descuento segun el tipo. Un 2x1 sin al menos dos
 * unidades elegibles lanza `PromotionError` con la razon real (nunca un descuento 0 silencioso).
 * `percentage`/`fixed` conservan exactamente el calculo anterior (`computePromotionDiscount`).
 */
export function applyPromotionToOrder(args: {
  readonly promotion: Promotion;
  readonly orderTotal: number;
  readonly items: readonly PersistedOrderItem[];
  readonly canal: CanalPedido;
  readonly now: Date;
  readonly zonaHoraria: string;
  /** Dia de negocio (0-6), ver `assertPromotionApplicable`. */
  readonly diaNegocio?: number;
  /** Sucursal del pedido, ver `assertPromotionApplicable` (alcance por sucursal, migracion 038). */
  readonly propertyId?: string;
}): { readonly total: number; readonly discount: number } {
  const { promotion, orderTotal } = args;
  assertPromotionApplicable(promotion, orderTotal, args.now, args.zonaHoraria, args.canal, args.diaNegocio, args.propertyId);
  let discount: number;
  if (promotion.type === "cortesia") {
    discount = Math.min(computeCortesiaDiscount(promotion, args.items), orderTotal);
    if (discount <= 0) {
      throw new PromotionError(`El código "${promotion.code}" es un combo de cortesía: agregue un producto de la promoción y elija las piezas de cortesía.`);
    }
  } else if (promotion.type === "bogo") {
    discount = Math.min(computeBogoDiscount(promotion, args.items), orderTotal);
    if (discount <= 0) {
      throw new PromotionError(`El código "${promotion.code}" es 2x1: agregue al menos 2 piezas de los productos de la promoción.`);
    }
  } else {
    discount = computePromotionDiscount(promotion, orderTotal);
  }
  return { total: Math.round((orderTotal - discount) * 100) / 100, discount };
}

/**
 * Descuento de un combo de CORTESIA: por cada unidad de un producto DISPARADOR (`productIds`, p. ej.
 * nachos de pastor) en el pedido, hasta `courtesyQuantity` piezas de los productos de cortesia
 * (`courtesyProductIds`, p. ej. las aguas) quedan a $0. El cliente ELIGE las piezas de cortesia y esas
 * piezas ya vienen como renglones normales del pedido: el motor solo resta su precio (nunca agrega ni
 * cambia renglones). Se regalan primero las mas baratas (criterio conservador del negocio) y nunca mas
 * piezas que las que hay en el pedido. Sin disparador o sin piezas de cortesia el descuento es 0.
 */
export function computeCortesiaDiscount(promotion: Promotion, items: readonly PersistedOrderItem[]): number {
  const triggers = promotion.productIds && promotion.productIds.length > 0 ? new Set(promotion.productIds) : null;
  const courtesy = promotion.courtesyProductIds && promotion.courtesyProductIds.length > 0 ? new Set(promotion.courtesyProductIds) : null;
  const perTrigger = promotion.courtesyQuantity ?? 0;
  if (!triggers || !courtesy || perTrigger < 1) return 0;
  let triggerUnits = 0;
  const courtesyPrices: number[] = [];
  for (const item of items) {
    // Un producto que es a la vez disparador y de cortesia no se regala a si mismo.
    if (triggers.has(item.id)) {
      triggerUnits += item.quantity;
      continue;
    }
    if (courtesy.has(item.id)) {
      for (let i = 0; i < item.quantity; i += 1) courtesyPrices.push(item.price);
    }
  }
  const free = Math.min(triggerUnits * perTrigger, courtesyPrices.length);
  if (free <= 0) return 0;
  courtesyPrices.sort((a, b) => a - b);
  let discount = 0;
  for (const price of courtesyPrices.slice(0, free)) discount += price;
  return Math.round(discount * 100) / 100;
}

/** Unidades regaladas por renglon (mismo orden que `items`) de una promocion que regala UNIDADES ENTERAS (combo de cortesia o 2x1), con la misma seleccion que
 * `computeCortesiaDiscount` / `computeBogoDiscount`. `null` si el tipo no regala unidades (porcentaje o monto fijo). */
function unidadesGratisPorRenglon(promotion: Promotion, items: readonly PersistedOrderItem[]): number[] | null {
  const gratis = items.map(() => 0);
  if (promotion.type === "cortesia") {
    const triggers = promotion.productIds && promotion.productIds.length > 0 ? new Set(promotion.productIds) : null;
    const courtesy = promotion.courtesyProductIds && promotion.courtesyProductIds.length > 0 ? new Set(promotion.courtesyProductIds) : null;
    const perTrigger = promotion.courtesyQuantity ?? 0;
    if (!triggers || !courtesy || perTrigger < 1) return gratis;
    let triggerUnits = 0;
    const unidades: { idx: number; price: number }[] = [];
    items.forEach((item, idx) => {
      if (triggers.has(item.id)) triggerUnits += item.quantity;
      else if (courtesy.has(item.id)) for (let i = 0; i < item.quantity; i += 1) unidades.push({ idx, price: item.price });
    });
    unidades.sort((a, b) => a.price - b.price);
    for (const u of unidades.slice(0, Math.min(triggerUnits * perTrigger, unidades.length))) gratis[u.idx]! += 1;
    return gratis;
  }
  if (promotion.type === "bogo") {
    const ids = promotion.productIds && promotion.productIds.length > 0 ? new Set(promotion.productIds) : null;
    const unidades: { idx: number; price: number }[] = [];
    items.forEach((item, idx) => {
      if (ids && !ids.has(item.id)) return;
      for (let i = 0; i < item.quantity; i += 1) unidades.push({ idx, price: item.price });
    });
    unidades.sort((a, b) => b.price - a.price);
    const free = Math.floor(unidades.length / 2);
    for (const u of unidades.slice(unidades.length - free)) gratis[u.idx]! += 1;
    return gratis;
  }
  return null;
}

/**
 * D12 (QA-PM-R5-voz-06 / reglas-12): el pedido persistia los renglones a precio de lista y el `total` con el descuento ya restado, asi que la suma de renglones NO
 * cuadraba con el total ($448 contra $328 con las 2 aguas de cortesia; $168 contra $84 con el 2x1), contra la regla D12 (total = suma de renglones con las cortesias aplicadas).
 * El CFO deriva bruta y descuento de promocion como (suma de renglones - total): por eso el renglon regalado conserva su precio de lista en `listPrice` y
 * `restaurantes.cfo_renglones` (migracion 086) lo usa; bruta, descuento y neta del CFO quedan IGUALES a los de antes.
 * Devuelve los renglones tal como deben guardarse: las unidades REGALADAS por la promocion quedan en un renglon aparte a $0 (mismo producto, mismo nombre, para que la comanda
 * y el catalogo las sigan reconociendo; con `listPrice` = precio de lista, para que el CFO conserve la venta bruta y el descuento) y la suma de renglones es exactamente el total. Solo para promociones que regalan unidades enteras; porcentaje y monto fijo no
 * se reparten por renglon. Si la suma no cuadra con `total` (descuento recortado, redondeo) devuelve los renglones sin tocar: nunca empeora lo anterior.
 */
export function renglonesConPromocionAplicada(items: readonly PersistedOrderItem[], promotion: Promotion | null, total: number): readonly PersistedOrderItem[] {
  if (!promotion) return items;
  const gratis = unidadesGratisPorRenglon(promotion, items);
  if (!gratis || gratis.every((n) => n === 0)) return items;
  const out: PersistedOrderItem[] = [];
  items.forEach((item, idx) => {
    const g = Math.min(gratis[idx] ?? 0, item.quantity);
    if (g <= 0) out.push(item);
    else {
      if (item.quantity - g > 0) out.push({ ...item, quantity: item.quantity - g });
      out.push({ ...item, quantity: g, price: 0, listPrice: item.price, courtesy: true, promoCode: promotion.code });
    }
  });
  const suma = Math.round(out.reduce((acc, i) => acc + i.price * i.quantity, 0) * 100) / 100;
  return Math.abs(suma - total) < 0.005 ? out : items;
}

/** Une los renglones del MISMO producto y la MISMA tortilla sumando cantidades: un renglon de cortesia/2x1 a $0 junto a su renglon pagado es UN producto para quien lee el historial
 * ("lo de siempre", repetir pedido). El precio del renglon unido es el de LISTA (`listPrice` si el renglon fue regalado, si no `price`; el mayor): un producto regalado al 100 % no queda a $0.
 * Tortillas distintas del mismo producto (2 de maiz + 2 de harina) siguen en renglones separados. */
export function fusionarRenglonesPorProducto<T extends { readonly id?: string; readonly name: string; readonly price?: number; readonly quantity: number; readonly tortilla?: string }>(items: readonly T[]): T[] {
  const precioDeLista = (i: T): number | undefined => {
    const lista = (i as { listPrice?: unknown }).listPrice;
    return typeof lista === "number" && Number.isFinite(lista) ? lista : i.price;
  };
  const porClave = new Map<string, T>();
  for (const item of items) {
    const clave = `${item.id ?? item.name}|${item.tortilla ?? ""}`;
    const previo = porClave.get(clave);
    const precio = precioDeLista(item);
    if (!previo) {
      const { listPrice: _l, courtesy: _c, promoCode: _p, ...limpio } = item as T & { listPrice?: unknown; courtesy?: unknown; promoCode?: unknown };
      porClave.set(clave, { ...(limpio as unknown as T), ...(precio !== undefined ? { price: precio } : {}) });
    } else {
      const previoPrecio = previo.price;
      porClave.set(clave, { ...previo, quantity: previo.quantity + item.quantity, ...(precio !== undefined && (previoPrecio === undefined || precio > previoPrecio) ? { price: precio } : {}) });
    }
  }
  return [...porClave.values()];
}

export interface AutomaticPromotionSuggestion {
  readonly promotion: Promotion;
  /** Por que todavia no descuenta con este pedido. */
  readonly motivo: "faltan_productos" | "falta_elegir_cortesia";
}

export interface AutomaticPromotionResult {
  /** La mejor promocion automatica que SI descuenta (maximo descuento; empate -> codigo menor). */
  readonly applied: { readonly promotion: Promotion; readonly discount: number; readonly total: number } | null;
  /** Promociones que ya valen HOY (dia/hora/canal) pero a las que este pedido aun no llega: el agente las
   * ofrece al cliente. */
  readonly suggestions: readonly AutomaticPromotionSuggestion[];
}

/**
 * Promociones AUTOMATICAS (sin codigo): de las `autoApply` activas elige la que aplica a ESTE pedido segun
 * dia de negocio, hora, canal y renglones. UNA sola por pedido (la de mayor descuento). Reglas duras:
 *  - una promocion automatica SIN canales explicitos nunca aplica (defensa en profundidad, ademas del CHECK
 *    de la migracion 031): las de PM valen solo para recoger, JAMAS a domicilio;
 *  - una promocion que no vale hoy/en este canal se ignora en silencio (no es un error);
 *  - una que vale hoy pero a la que el pedido no llega queda como sugerencia, no como descuento.
 * No toca precios de linea: solo calcula el monto a restar, igual que el resto del motor.
 */
export function selectAutomaticPromotion(args: {
  readonly promotions: readonly Promotion[];
  readonly orderTotal: number;
  readonly items: readonly PersistedOrderItem[];
  readonly canal: CanalPedido;
  readonly now: Date;
  readonly zonaHoraria: string;
  readonly diaNegocio?: number;
  /** Sucursal del pedido (alcance por sucursal, migracion 038): una promocion automatica con alcance que no incluye esta
   * sucursal se ignora en silencio (ni descuenta ni se sugiere). */
  readonly propertyId?: string;
}): AutomaticPromotionResult {
  let best: { promotion: Promotion; discount: number; total: number } | null = null;
  const suggestions: AutomaticPromotionSuggestion[] = [];
  const ordered = [...args.promotions].sort((a, b) => a.code.localeCompare(b.code));
  for (const promotion of ordered) {
    if (!promotion.autoApply || !promotion.isActive) continue;
    if (!promotion.channels || promotion.channels.length === 0) continue;
    try {
      assertPromotionApplicable(promotion, args.orderTotal, args.now, args.zonaHoraria, args.canal, args.diaNegocio, args.propertyId);
    } catch (err) {
      if (err instanceof PromotionError) continue; // hoy / en este canal no vale
      throw err;
    }
    let result: { total: number; discount: number } | null = null;
    try {
      result = applyPromotionToOrder({ promotion, orderTotal: args.orderTotal, items: args.items, canal: args.canal, now: args.now, zonaHoraria: args.zonaHoraria, diaNegocio: args.diaNegocio, propertyId: args.propertyId });
    } catch (err) {
      if (!(err instanceof PromotionError)) throw err;
    }
    if (!result || result.discount <= 0) {
      const hayDisparador = promotion.productIds?.some((id) => args.items.some((i) => i.id === id)) ?? false;
      suggestions.push({ promotion, motivo: promotion.type === "cortesia" && hayDisparador ? "falta_elegir_cortesia" : "faltan_productos" });
      continue;
    }
    if (!best || result.discount > best.discount) best = { promotion, discount: result.discount, total: result.total };
  }
  return { applied: best, suggestions };
}
