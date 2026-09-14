// Reconciliación completa y backoff — port literal de
// rentas/packages/adapters/src/sync/reconciliacion.ts (repo origen, H-032, H-034,
// caso adversarial 17). Funciones puras: la orquestación real (fetch + escritura
// transaccional) vive en ./motor.ts.

export interface OpcionesBackoff {
  baseMs: number;
  maxMs: number;
  factor: number;
}

export const OPCIONES_BACKOFF_POR_DEFECTO: OpcionesBackoff = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  factor: 2,
};

/** Backoff exponencial con tope, respetando `Retry-After` (segundos) si el canal lo
 * emite en un 429 — nunca reintenta más agresivo que lo que el canal pide
 * explícitamente. */
export function calcularBackoffMs(intentoNumero: number, opciones: OpcionesBackoff = OPCIONES_BACKOFF_POR_DEFECTO, retryAfterSegundos?: number | null): number {
  if (retryAfterSegundos !== undefined && retryAfterSegundos !== null && retryAfterSegundos >= 0) {
    return Math.min(retryAfterSegundos * 1000, opciones.maxMs);
  }
  const exponencial = opciones.baseMs * Math.pow(opciones.factor, Math.max(0, intentoNumero - 1));
  return Math.min(exponencial, opciones.maxMs);
}

export interface UidActivoInterno {
  ocupacionId: string;
  uidCanal: string;
}

export interface ResultadoReconciliacionCompleta {
  /** UIDs activos internamente para ese canal/unidad que YA NO aparecen en el feed
   * más reciente — candidatos a cancelación implícita (sujeta siempre a revisión
   * humana, nunca cancelación automática). */
  candidatosACancelarPorAusencia: UidActivoInterno[];
  /** Conteo de discrepancias — expuesto como métrica de "drift". */
  drift: number;
}

/** Reconciliación completa: compara el conjunto de UIDs activos internamente contra
 * el conjunto de UIDs presentes en el feed actual. La reconciliación INCREMENTAL
 * (upsert por evento) se hace directamente con `resolverVersionEvento` por cada evento
 * del feed — no necesita una función dedicada aquí. */
export function reconciliarCompleto(activosInternos: readonly UidActivoInterno[], uidsPresentesEnFeedActual: ReadonlySet<string>): ResultadoReconciliacionCompleta {
  const candidatosACancelarPorAusencia = activosInternos.filter((a) => !uidsPresentesEnFeedActual.has(a.uidCanal));
  return { candidatosACancelarPorAusencia, drift: candidatosACancelarPorAusencia.length };
}
