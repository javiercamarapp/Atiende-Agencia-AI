/** Restaurantes, grupo «ajustes»: Configuracion, onboarding, login, demo y vista previa. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesConfiguracion } from "../configuracion.ts";
import type { restaurantesOnboarding } from "../onboarding.ts";
import type { restaurantesPreview } from "../preview.ts";

export interface ModulosRestaurantesAjustes {
  readonly restaurantesConfiguracion: typeof restaurantesConfiguracion;
  readonly restaurantesOnboarding: typeof restaurantesOnboarding;
  readonly restaurantesPreview: typeof restaurantesPreview;
}
