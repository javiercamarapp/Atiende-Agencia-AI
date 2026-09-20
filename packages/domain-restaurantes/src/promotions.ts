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
import type { Promotion } from "./types.ts";

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
export function assertPromotionApplicable(promotion: Promotion, orderTotal: number, now: Date, zonaHoraria: string): void {
  if (!promotion.isActive) {
    throw new PromotionError(`El código "${promotion.code}" ya no está activo.`);
  }
  if (promotion.startsAt && now.getTime() < new Date(promotion.startsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" todavía no está vigente.`);
  }
  if (promotion.endsAt && now.getTime() > new Date(promotion.endsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" ya expiró.`);
  }
  const { dayOfWeek, minutesSinceMidnight: nowMinutes } = partesDeHoyEnZona(now, zonaHoraria);
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
  assertPromotionApplicable(promotion, orderTotal, now, zonaHoraria);
  const discount = computePromotionDiscount(promotion, orderTotal);
  return { total: Math.round((orderTotal - discount) * 100) / 100, discount };
}
