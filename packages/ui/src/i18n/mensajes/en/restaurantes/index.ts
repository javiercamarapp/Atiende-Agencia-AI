/** Ingles de las paginas de restaurantes: una linea por modulo (ver `mensajes/restaurantes/index.ts`). Viaja en el chunk EN. */
import { restaurantesComunEn } from "./comun.ts";
import { restaurantesPedidosEn } from "./pedidos.ts";
import { restaurantesResumenEn } from "./resumen.ts";

export const MODULOS_EN_RESTAURANTES = {
  restaurantesComun: restaurantesComunEn,
  restaurantesPedidos: restaurantesPedidosEn,
  restaurantesResumen: restaurantesResumenEn,
} as const;
