// QA-PM-R6-voz-01: el cliente cuelga y vuelve a llamar (o escribe) con el MISMO pedido: sin esta guarda nacian dos pedidos identicos con segundos de diferencia (la huella de
// deduplicacion incluye la hora de recogida y las notas, que cambian entre llamadas, y el flujo de pedido es por llamada). Pura + una lectura; nada que ver con la idempotencia
// de un reintento de red (esa vive en createOrderIdempotent).
import type { PersistedOrderItem, QuotedOrderLine } from "./types.ts";

/** Ventana en la que un pedido igual del mismo telefono se toma como el mismo pedido, no como uno nuevo. */
export const VENTANA_PEDIDO_IGUAL_MIN = 10;

function porProducto(items: readonly { readonly id: string; readonly quantity: number }[]): string {
  const acumulado = new Map<string, number>();
  for (const it of items) acumulado.set(it.id, (acumulado.get(it.id) ?? 0) + it.quantity);
  return [...acumulado.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, q]) => `${id}|${q}`).join(";");
}

/** ¿Los renglones cotizados son los mismos productos y cantidades que los de un pedido ya creado? (la cortesia de una promocion suma a la cantidad del mismo producto). */
export function mismosRenglones(persistidos: unknown, cotizados: unknown): boolean {
  if (!Array.isArray(persistidos) || !Array.isArray(cotizados) || persistidos.length === 0 || cotizados.length === 0) return false;
  const validos = (l: unknown[]): boolean => l.every((x) => !!x && typeof x === "object" && typeof (x as { quantity?: unknown }).quantity === "number" && Number.isFinite((x as { quantity: number }).quantity));
  if (!validos(persistidos) || !validos(cotizados)) return false;
  const a = (persistidos as PersistedOrderItem[]).map((i) => ({ id: String(i.id), quantity: i.quantity }));
  const b = (cotizados as QuotedOrderLine[]).map((l) => ({ id: String(l.productId), quantity: l.quantity }));
  return porProducto(a) === porProducto(b);
}
