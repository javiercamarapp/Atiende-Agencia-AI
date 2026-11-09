/** Ingles del grupo «agente» de restaurantes (ver mensajes/restaurantes/grupos/agente.ts). */
import { restaurantesAgenteWhatsappEn } from "../agenteWhatsapp.ts";
import { restaurantesConocimientoEn } from "../conocimiento.ts";
import { restaurantesIndicadoresWhatsappEn } from "../indicadoresWhatsapp.ts";

export const EN_RESTAURANTES_AGENTE = {
  restaurantesAgenteWhatsapp: restaurantesAgenteWhatsappEn,
  restaurantesConocimiento: restaurantesConocimientoEn,
  restaurantesIndicadoresWhatsapp: restaurantesIndicadoresWhatsappEn,
} as const;
