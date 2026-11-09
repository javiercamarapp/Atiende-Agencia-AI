/** Ingles del grupo «catalogo» de restaurantes (ver mensajes/restaurantes/grupos/catalogo.ts). */
import { restaurantesProductosEn } from "../productos.ts";
import { restaurantesSucursalesEn } from "../sucursales.ts";
import { restaurantesReglasEn } from "../reglas.ts";
import { restaurantesPromocionesEn } from "../promociones.ts";
import { restaurantesCampanasEn } from "../campanas.ts";

export const EN_RESTAURANTES_CATALOGO = {
  restaurantesProductos: restaurantesProductosEn,
  restaurantesSucursales: restaurantesSucursalesEn,
  restaurantesReglas: restaurantesReglasEn,
  restaurantesPromociones: restaurantesPromocionesEn,
  restaurantesCampanas: restaurantesCampanasEn,
} as const;
