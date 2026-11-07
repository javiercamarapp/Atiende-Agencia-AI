/** Ingles de las paginas de licitaciones: un grupo por linea (ver `mensajes/licitaciones/index.ts`). Viaja en el chunk EN. */
import { EN_LICITACIONES_BASE } from "./grupos/base.ts";
import { EN_LICITACIONES_OPERACION } from "./grupos/operacion.ts";
import { EN_LICITACIONES_FINANZAS } from "./grupos/finanzas.ts";
import { EN_LICITACIONES_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_LICITACIONES = {
  ...EN_LICITACIONES_BASE,
  ...EN_LICITACIONES_OPERACION,
  ...EN_LICITACIONES_FINANZAS,
  ...EN_LICITACIONES_AJUSTES,
} as const;
