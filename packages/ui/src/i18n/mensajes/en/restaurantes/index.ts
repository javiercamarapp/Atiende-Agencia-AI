/** Ingles de las paginas de restaurantes: una linea por modulo (ver `mensajes/restaurantes/index.ts`). Viaja en el chunk EN. */
import { EN_RESTAURANTES_BASE } from "./grupos/base.ts";
import { EN_RESTAURANTES_AUTOPILOTO } from "./grupos/autopiloto.ts";
import { EN_RESTAURANTES_OPERACION } from "./grupos/operacion.ts";
import { EN_RESTAURANTES_CATALOGO } from "./grupos/catalogo.ts";
import { EN_RESTAURANTES_CLIENTES } from "./grupos/clientes.ts";
import { EN_RESTAURANTES_AGENTE } from "./grupos/agente.ts";
import { EN_RESTAURANTES_CFO } from "./grupos/cfo.ts";
import { EN_RESTAURANTES_AJUSTES } from "./grupos/ajustes.ts";

export const MODULOS_EN_RESTAURANTES = {
  ...EN_RESTAURANTES_BASE,
  ...EN_RESTAURANTES_AUTOPILOTO,
  ...EN_RESTAURANTES_OPERACION,
  ...EN_RESTAURANTES_CATALOGO,
  ...EN_RESTAURANTES_CLIENTES,
  ...EN_RESTAURANTES_AGENTE,
  ...EN_RESTAURANTES_CFO,
  ...EN_RESTAURANTES_AJUSTES,
} as const;
