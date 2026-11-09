/** Restaurantes, grupo «agente»: Agente de WhatsApp, agente de voz, conocimiento e indicadores. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesAgenteWhatsapp } from "../agenteWhatsapp.ts";
import type { restaurantesConocimiento } from "../conocimiento.ts";
import type { restaurantesIndicadoresWhatsapp } from "../indicadoresWhatsapp.ts";
import type { restaurantesAgenteVoz } from "../agenteVoz.ts";
import type { restaurantesIndicadoresVoz } from "../indicadoresVoz.ts";

export interface ModulosRestaurantesAgente {
  readonly restaurantesAgenteWhatsapp: typeof restaurantesAgenteWhatsapp;
  readonly restaurantesConocimiento: typeof restaurantesConocimiento;
  readonly restaurantesIndicadoresWhatsapp: typeof restaurantesIndicadoresWhatsapp;
  readonly restaurantesAgenteVoz: typeof restaurantesAgenteVoz;
  readonly restaurantesIndicadoresVoz: typeof restaurantesIndicadoresVoz;
}
