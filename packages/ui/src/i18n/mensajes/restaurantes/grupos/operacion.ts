/** Restaurantes, grupo «operacion»: Comandas, conversaciones, callbacks, avisos, historial, operacion del dia y repartidor. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesOperacion } from "../operacion.ts";
import type { restaurantesCaptura } from "../captura.ts";
import type { restaurantesViajes } from "../viajes.ts";
import type { restaurantesAgregados } from "../agregados.ts";

export interface ModulosRestaurantesOperacion {
  readonly restaurantesOperacion: typeof restaurantesOperacion;
  readonly restaurantesCaptura: typeof restaurantesCaptura;
  readonly restaurantesViajes: typeof restaurantesViajes;
  readonly restaurantesAgregados: typeof restaurantesAgregados;
}
