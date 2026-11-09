/** Ingles del grupo «autopiloto» de restaurantes (ver mensajes/restaurantes/grupos/autopiloto.ts). */
import { restaurantesAutopilotoEn } from "../autopiloto.ts";
import { restaurantesHistorialEn } from "../historial.ts";
import { restaurantesComandasEn } from "../comandas.ts";
import { restaurantesConversacionesEn } from "../conversaciones.ts";
import { restaurantesAvisosEn } from "../avisos.ts";

export const EN_RESTAURANTES_AUTOPILOTO = {
  restaurantesAutopiloto: restaurantesAutopilotoEn,
  restaurantesHistorial: restaurantesHistorialEn,
  restaurantesComandas: restaurantesComandasEn,
  restaurantesConversaciones: restaurantesConversacionesEn,
  restaurantesAvisos: restaurantesAvisosEn,
} as const;
