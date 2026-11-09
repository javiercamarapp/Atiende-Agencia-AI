/** Ingles de las paginas de rentas: un grupo por linea (ver `mensajes/rentas/index.ts`). Viaja en el chunk EN. */
import { EN_RENTAS_BASE } from "./grupos/base.ts";
import { EN_RENTAS_OPERACION } from "./grupos/operacion.ts";
import { EN_RENTAS_FINANZAS } from "./grupos/finanzas.ts";
import { EN_RENTAS_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_RENTAS = {
  ...EN_RENTAS_BASE,
  ...EN_RENTAS_OPERACION,
  ...EN_RENTAS_FINANZAS,
  ...EN_RENTAS_AJUSTES,
} as const;
