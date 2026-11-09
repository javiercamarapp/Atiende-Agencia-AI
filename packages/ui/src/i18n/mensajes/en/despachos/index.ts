/** Ingles de las paginas de despachos: un grupo por linea (ver `mensajes/despachos/index.ts`). Viaja en el chunk EN. */
import { EN_DESPACHOS_BASE } from "./grupos/base.ts";
import { EN_DESPACHOS_OPERACION } from "./grupos/operacion.ts";
import { EN_DESPACHOS_FINANZAS } from "./grupos/finanzas.ts";
import { EN_DESPACHOS_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_DESPACHOS = {
  ...EN_DESPACHOS_BASE,
  ...EN_DESPACHOS_OPERACION,
  ...EN_DESPACHOS_FINANZAS,
  ...EN_DESPACHOS_AJUSTES,
} as const;
