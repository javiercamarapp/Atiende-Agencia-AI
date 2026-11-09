/** Despachos, grupo «base»: Resumen y pantallas principales. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { despachosResumen } from "../resumen.ts";

export interface ModulosDespachosBase {
  readonly despachosResumen: typeof despachosResumen;
}
