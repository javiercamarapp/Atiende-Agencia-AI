// Fase del "pensando" segun el tiempo transcurrido: la ultima cuyo umbral ya paso.
export function faseSegunTiempo(fases: ReadonlyArray<readonly [number, string]>, transcurridoMs: number): string {
  let texto = fases[0]?.[1] ?? "";
  for (const [desde, t] of fases) {
    if (transcurridoMs >= desde) texto = t;
  }
  return texto;
}

/** Cadencia con la que se revisa el reloj de fases (la de Likida). */
export const TICK_FASES_MS = 700;
/** Tope de espera de un turno en el cliente (la de Likida). */
export const TIMEOUT_TURNO_MS = 75_000;
