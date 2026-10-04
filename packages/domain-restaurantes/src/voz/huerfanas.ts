// Barrido de llamadas de voz HUERFANAS (QA-restaurantes-R1-automatizacion-08): una llamada cuyo worker murio antes de /cerrar quedaba "en curso" para
// siempre y el KPI subestimaba el abandono. El barrido (cron) la cierra como `abandonado` con duracion y costo calculados por la base (migracion 042).
import type { VozRepository } from "./repository.ts";
import { VozNoDisponibleError } from "./types.ts";

/** Inactividad a partir de la cual una llamada abierta se considera huerfana (la duracion maxima de una llamada es de 8 min). */
export const HUERFANAS_INACTIVAS_MIN = 120;
/** Tope de llamadas cerradas por corrida (el cron corre seguido; el resto cae en la siguiente). */
export const HUERFANAS_LOTE = 200;

export interface BarridoHuerfanas {
  /** `false` si la base todavia no tiene la migracion 042 (vacio honesto: no se cerro nada). */
  readonly disponible: boolean;
  readonly cerradas: number;
}

/** Cierra las llamadas huerfanas. Sesion de sistema; sin la migracion 042 devuelve `{ disponible: false }` en vez de fallar. */
export async function cerrarLlamadasHuerfanas(repo: VozRepository, opciones: { readonly inactivasMinutos?: number; readonly limite?: number } = {}): Promise<BarridoHuerfanas> {
  try {
    const cerradas = await repo.cerrarHuerfanas({ inactivasMinutos: opciones.inactivasMinutos ?? HUERFANAS_INACTIVAS_MIN, limite: opciones.limite ?? HUERFANAS_LOTE });
    return { disponible: true, cerradas };
  } catch (err) {
    if (err instanceof VozNoDisponibleError) return { disponible: false, cerradas: 0 };
    throw err;
  }
}
