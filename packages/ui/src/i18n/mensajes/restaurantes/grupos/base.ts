/** Restaurantes, grupo «base»: Terminos comunes, Resumen y Pedidos. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesComun } from "../comun.ts";
import type { restaurantesPedidos } from "../pedidos.ts";
import type { restaurantesResumen } from "../resumen.ts";

export interface ModulosRestaurantesBase {
  readonly restaurantesComun: typeof restaurantesComun;
  readonly restaurantesPedidos: typeof restaurantesPedidos;
  readonly restaurantesResumen: typeof restaurantesResumen;
}
