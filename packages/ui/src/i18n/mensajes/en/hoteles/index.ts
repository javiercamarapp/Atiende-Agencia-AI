/** Ingles de las paginas de hoteles: un grupo por linea (ver `mensajes/hoteles/index.ts`). Viaja en el chunk EN. */
import { EN_HOTELES_BASE } from "./grupos/base.ts";
import { EN_HOTELES_OPERACION } from "./grupos/operacion.ts";
import { EN_HOTELES_FINANZAS } from "./grupos/finanzas.ts";
import { EN_HOTELES_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_HOTELES = {
  ...EN_HOTELES_BASE,
  ...EN_HOTELES_OPERACION,
  ...EN_HOTELES_FINANZAS,
  ...EN_HOTELES_AJUSTES,
} as const;
