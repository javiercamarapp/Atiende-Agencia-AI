/** Ingles del grupo «operacion» de restaurantes (ver mensajes/restaurantes/grupos/operacion.ts). */
import { restaurantesOperacionEn } from "../operacion.ts";
import { restaurantesCapturaEn } from "../captura.ts";
import { restaurantesViajesEn } from "../viajes.ts";
import { restaurantesAgregadosEn } from "../agregados.ts";

export const EN_RESTAURANTES_OPERACION = {
  restaurantesOperacion: restaurantesOperacionEn,
  restaurantesCaptura: restaurantesCapturaEn,
  restaurantesViajes: restaurantesViajesEn,
  restaurantesAgregados: restaurantesAgregadosEn,
} as const;
