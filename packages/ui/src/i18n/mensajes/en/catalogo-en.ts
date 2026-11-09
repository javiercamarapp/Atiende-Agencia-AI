/**
 * Catalogo en ingles: un chunk APARTE que se descarga solo cuando alguien elige EN (`cargarIdioma("en")`). `satisfies` exige
 * una traduccion por cada modulo de `MODULOS` (y ninguna de mas). Para agregar un modulo: su archivo aqui + una linea abajo.
 */
import type { ModulosTraducidos } from "../index.ts";
import { cargaEn } from "./carga.ts";
import { comunEn } from "./comun.ts";
import { consolaEn } from "./consola.ts";
import { datosEn } from "./datos.ts";
import { navEn } from "./nav.ts";
import { notifEn } from "./notif.ts";
import { rolEn } from "./rol.ts";
import { shellEn } from "./shell.ts";
import { waMetaEn } from "./waMeta.ts";

export const MODULOS_EN = {
  comun: comunEn,
  nav: navEn,
  shell: shellEn,
  rol: rolEn,
  consola: consolaEn,
  notif: notifEn,
  datos: datosEn,
  waMeta: waMetaEn,
  carga: cargaEn,
} as const satisfies ModulosTraducidos;
