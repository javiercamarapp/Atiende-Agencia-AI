/** Ingles del grupo «base» de restaurantes (ver mensajes/restaurantes/grupos/base.ts). */
import { restaurantesComunEn } from "../comun.ts";
import { restaurantesPedidosEn } from "../pedidos.ts";
import { restaurantesResumenEn } from "../resumen.ts";

export const EN_RESTAURANTES_BASE = {
  restaurantesComun: restaurantesComunEn,
  restaurantesPedidos: restaurantesPedidosEn,
  restaurantesResumen: restaurantesResumenEn,
} as const;
