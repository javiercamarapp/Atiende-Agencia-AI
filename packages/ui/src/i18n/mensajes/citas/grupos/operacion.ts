/** Citas, grupo «operacion»: Operacion diaria. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { citasAvisos } from "../avisos.ts";

export interface ModulosCitasOperacion {
  readonly citasAvisos: typeof citasAvisos;
}
