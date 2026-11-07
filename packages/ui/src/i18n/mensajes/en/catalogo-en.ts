/**
 * Catalogo en ingles: un chunk APARTE que se descarga solo cuando alguien elige EN (`cargarIdioma("en")`). `satisfies` exige
 * una traduccion por cada modulo de `MODULOS` (y ninguna de mas). Para agregar un modulo: su archivo aqui + una linea abajo.
 */
import type { ModulosTraducidos } from "../index.ts";
import { comunEn } from "./comun.ts";
import { MODULOS_EN_RESTAURANTES } from "./restaurantes/index.ts";

export const MODULOS_EN = {
  comun: comunEn,
  ...MODULOS_EN_RESTAURANTES,
} as const satisfies ModulosTraducidos;
