/**
 * Catalogo en ingles: un chunk APARTE que se descarga solo cuando alguien elige EN (`cargarIdioma("en")`). `satisfies` exige
 * una traduccion por cada modulo de `MODULOS` (y ninguna de mas). Para agregar un modulo: su archivo aqui + una linea abajo.
 */
import type { ModulosTraducidos } from "../index.ts";
import { cargaEn } from "./carga.ts";
import { comunEn } from "./comun.ts";

export const MODULOS_EN = {
  comun: comunEn,
  carga: cargaEn,
} as const satisfies ModulosTraducidos;
