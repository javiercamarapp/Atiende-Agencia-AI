/** Ingles del grupo «base» de superadmin (ver mensajes/superadmin/grupos/base.ts). */
import { superadminComunEn } from "../comun.ts";
import { superadminResumenEn } from "../resumen.ts";
import { superadminConsolaEn } from "../consola.ts";
import { superadminOrganizacionesEn } from "../organizaciones.ts";
import { superadminGestionEn } from "../gestion.ts";
import { superadminFichaEn } from "../ficha.ts";
import { superadminEquipoEn } from "../equipo.ts";

export const EN_SUPERADMIN_BASE = {
  superadminComun: superadminComunEn,
  superadminResumen: superadminResumenEn,
  superadminConsola: superadminConsolaEn,
  superadminOrganizaciones: superadminOrganizacionesEn,
  superadminGestion: superadminGestionEn,
  superadminFicha: superadminFichaEn,
  superadminEquipo: superadminEquipoEn,
} as const;
