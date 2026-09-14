import { sumarDias } from "../fechas.ts";
import type { FechaLocal, RangoFechas } from "../tipos.ts";

/**
 * Buffer de limpieza checkout↔check-in (H-050, REQ-054/REQ-112) — port de
 * rentas/packages/domain/src/limpieza/buffer.ts. La razón `BUFFER_LIMPIEZA` ya existe
 * en `../tipos.ts::Razon` desde la Fase 1 (es justamente el gap que cierra este
 * lote: hasta ahora era un valor de enum sin ningún módulo que lo produjera).
 * `bufferLimpiezaNoches` es configurable por property (0 = sin buffer). El rango
 * resultante se inserta siempre vía `crearBloqueo` (../../aplicacion/reservas.ts,
 * ya existente) — este módulo solo calcula el rango `[checkout, checkout + n
 * noches)`, nunca toca base de datos.
 */
export function calcularRangoBuffer(fechaCheckout: FechaLocal, bufferNoches: number): RangoFechas | null {
  if (bufferNoches <= 0) return null;
  return { inicio: fechaCheckout, fin: sumarDias(fechaCheckout, bufferNoches) };
}
