/** Ingles de las paginas de citas: un grupo por linea (ver `mensajes/citas/index.ts`). Viaja en el chunk EN. */
import { EN_CITAS_BASE } from "./grupos/base.ts";
import { EN_CITAS_OPERACION } from "./grupos/operacion.ts";
import { EN_CITAS_FINANZAS } from "./grupos/finanzas.ts";
import { EN_CITAS_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_CITAS = {
  ...EN_CITAS_BASE,
  ...EN_CITAS_OPERACION,
  ...EN_CITAS_FINANZAS,
  ...EN_CITAS_AJUSTES,
} as const;
