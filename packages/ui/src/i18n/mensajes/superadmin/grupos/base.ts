/** Superadmin, grupo «base»: Resumen, consola y organizaciones. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { superadminComun } from "../comun.ts";
import type { superadminResumen } from "../resumen.ts";
import type { superadminConsola } from "../consola.ts";
import type { superadminOrganizaciones } from "../organizaciones.ts";
import type { superadminGestion } from "../gestion.ts";
import type { superadminFicha } from "../ficha.ts";
import type { superadminEquipo } from "../equipo.ts";

export interface ModulosSuperadminBase {
  readonly superadminComun: typeof superadminComun;
  readonly superadminResumen: typeof superadminResumen;
  readonly superadminConsola: typeof superadminConsola;
  readonly superadminOrganizaciones: typeof superadminOrganizaciones;
  readonly superadminGestion: typeof superadminGestion;
  readonly superadminFicha: typeof superadminFicha;
  readonly superadminEquipo: typeof superadminEquipo;
}
