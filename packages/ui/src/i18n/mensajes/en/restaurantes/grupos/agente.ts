/** Ingles del grupo «agente» de restaurantes (ver mensajes/restaurantes/grupos/agente.ts). */
import { restaurantesAgenteWhatsappEn } from "../agenteWhatsapp.ts";
import { restaurantesConocimientoEn } from "../conocimiento.ts";
import { restaurantesIndicadoresWhatsappEn } from "../indicadoresWhatsapp.ts";
import { restaurantesAgenteVozEn } from "../agenteVoz.ts";
import { restaurantesIndicadoresVozEn } from "../indicadoresVoz.ts";
import { restaurantesAjustesAgenteEn } from "../ajustesAgente.ts";

export const EN_RESTAURANTES_AGENTE = {
  restaurantesAgenteWhatsapp: restaurantesAgenteWhatsappEn,
  restaurantesConocimiento: restaurantesConocimientoEn,
  restaurantesIndicadoresWhatsapp: restaurantesIndicadoresWhatsappEn,
  restaurantesAgenteVoz: restaurantesAgenteVozEn,
  restaurantesIndicadoresVoz: restaurantesIndicadoresVozEn,
  restaurantesAjustesAgente: restaurantesAjustesAgenteEn,
} as const;
