/**
 * Catalogo en ingles: un chunk APARTE que se descarga solo cuando alguien elige EN (`cargarIdioma("en")`). `satisfies` exige
 * una traduccion por cada modulo de `MODULOS` (y ninguna de mas). Para agregar un modulo: su archivo aqui + una linea abajo.
 */
import type { ModulosTraducidos } from "../index.ts";
import { comunEn } from "./comun.ts";
import { consumoEn } from "./consumo.ts";

export const MODULOS_EN = {
  comun: comunEn,
  consumo: consumoEn,
} as const satisfies ModulosTraducidos;
