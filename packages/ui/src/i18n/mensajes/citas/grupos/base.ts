/** Citas, grupo «base»: Resumen y pantallas principales. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { citasComun } from "../comun.ts";
import type { citasResumen } from "../resumen.ts";
import type { citasClientes } from "../clientes.ts";
import type { citasAgenda } from "../agenda.ts";

export interface ModulosCitasBase {
  readonly citasComun: typeof citasComun;
  readonly citasResumen: typeof citasResumen;
  readonly citasClientes: typeof citasClientes;
  readonly citasAgenda: typeof citasAgenda;
}
