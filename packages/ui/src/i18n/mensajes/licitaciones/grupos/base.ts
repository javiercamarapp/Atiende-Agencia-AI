/** Licitaciones, grupo «base»: Resumen y pantallas principales. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { licitacionesResumen } from "../resumen.ts";

export interface ModulosLicitacionesBase {
  readonly licitacionesResumen: typeof licitacionesResumen;
}
