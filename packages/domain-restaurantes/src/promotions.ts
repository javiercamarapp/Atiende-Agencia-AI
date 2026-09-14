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

/**
 * Valida que una promoción sea aplicable AHORA, contra un total de pedido ya
 * calculado por el motor real — activa, dentro de starts_at/ends_at, dentro de
 * days_of_week si se definió, dentro de start_time/end_time si se definió
 * (soporta ventana que cruza medianoche, ej. 22:00-02:00), bajo max_uses si se
 * definió, y el total alcanza min_order_total si se definió. Nunca lanza
 * silenciosamente: cada rechazo nombra la razón real, para que la ruta HTTP (o el
 * agente de voz/WhatsApp) se lo explique al cliente en vez de un "código
 * inválido" genérico.
 */
export function assertPromotionApplicable(promotion: Promotion, orderTotal: number, now: Date): void {
  if (!promotion.isActive) {
    throw new PromotionError(`El código "${promotion.code}" ya no está activo.`);
  }
  if (promotion.startsAt && now.getTime() < new Date(promotion.startsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" todavía no está vigente.`);
  }
  if (promotion.endsAt && now.getTime() > new Date(promotion.endsAt).getTime()) {
    throw new PromotionError(`El código "${promotion.code}" ya expiró.`);
  }
  if (promotion.daysOfWeek && promotion.daysOfWeek.length > 0 && !promotion.daysOfWeek.includes(now.getDay())) {
    throw new PromotionError(`El código "${promotion.code}" no aplica el día de hoy.`);
  }
  if (promotion.startTime !== null || promotion.endTime !== null) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
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
 * real. Nunca toca renglones/precios de producto.
 */
export function applyPromotionToOrderTotal(orderTotal: number, promotion: Promotion, now: Date): { readonly total: number; readonly discount: number } {
  assertPromotionApplicable(promotion, orderTotal, now);
  const discount = computePromotionDiscount(promotion, orderTotal);
  return { total: Math.round((orderTotal - discount) * 100) / 100, discount };
}
