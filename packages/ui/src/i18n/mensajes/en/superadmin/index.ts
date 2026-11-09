/** Ingles de las paginas de superadmin: un grupo por linea (ver `mensajes/superadmin/index.ts`). Viaja en el chunk EN. */
import { EN_SUPERADMIN_BASE } from "./grupos/base.ts";
import { EN_SUPERADMIN_COMERCIAL } from "./grupos/comercial.ts";
import { EN_SUPERADMIN_COSTOS } from "./grupos/costos.ts";
import { EN_SUPERADMIN_SEGURIDAD } from "./grupos/seguridad.ts";
import { EN_SUPERADMIN_AGENTES } from "./grupos/agentes.ts";

export const MODULOS_EN_SUPERADMIN = {
  ...EN_SUPERADMIN_BASE,
  ...EN_SUPERADMIN_COMERCIAL,
  ...EN_SUPERADMIN_COSTOS,
  ...EN_SUPERADMIN_SEGURIDAD,
  ...EN_SUPERADMIN_AGENTES,
} as const;
