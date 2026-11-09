/** Ingles del grupo «operacion» de restaurantes (ver mensajes/restaurantes/grupos/operacion.ts). */
import { restaurantesOperacionEn } from "../operacion.ts";
import { restaurantesCapturaEn } from "../captura.ts";
import { restaurantesViajesEn } from "../viajes.ts";
import { restaurantesAgregadosEn } from "../agregados.ts";
import { restaurantesChoferEn } from "../chofer.ts";
import { restaurantesAccesoChoferEn } from "../accesoChofer.ts";

export const EN_RESTAURANTES_OPERACION = {
  restaurantesOperacion: restaurantesOperacionEn,
  restaurantesCaptura: restaurantesCapturaEn,
  restaurantesViajes: restaurantesViajesEn,
  restaurantesAgregados: restaurantesAgregadosEn,
  restaurantesChofer: restaurantesChoferEn,
  restaurantesAccesoChofer: restaurantesAccesoChoferEn,
} as const;
