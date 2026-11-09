/** Citas, grupo «ajustes»: Configuracion, equipo, privacidad y onboarding. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { citasServicios } from "../servicios.ts";
import type { citasStaff } from "../staff.ts";
import type { citasDisponibilidad } from "../disponibilidad.ts";

export interface ModulosCitasAjustes {
  readonly citasServicios: typeof citasServicios;
  readonly citasStaff: typeof citasStaff;
  readonly citasDisponibilidad: typeof citasDisponibilidad;
}
