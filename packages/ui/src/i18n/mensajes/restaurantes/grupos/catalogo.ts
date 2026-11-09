/** Restaurantes, grupo «catalogo»: Productos, sucursales, reglas, promociones y campanas. Un PR por grupo edita SOLO este archivo (y su par en en/), sin chocar con los demas. */
import type { restaurantesProductos } from "../productos.ts";
import type { restaurantesSucursales } from "../sucursales.ts";
import type { restaurantesReglas } from "../reglas.ts";
import type { restaurantesPromociones } from "../promociones.ts";
import type { restaurantesCampanas } from "../campanas.ts";

export interface ModulosRestaurantesCatalogo {
  readonly restaurantesProductos: typeof restaurantesProductos;
  readonly restaurantesSucursales: typeof restaurantesSucursales;
  readonly restaurantesReglas: typeof restaurantesReglas;
  readonly restaurantesPromociones: typeof restaurantesPromociones;
  readonly restaurantesCampanas: typeof restaurantesCampanas;
}
