/**
 * Paginas de restaurantes (i18n ES/EN). Un modulo por pantalla o grupo de pantallas, con claves `restaurantes.<modulo>.*`.
 * Cada modulo es de AREA: viaja en el chunk de la pagina que lo usa (`import { restaurantesPedidos } from
 * "@atiende/ui/i18n/restaurantes/pedidos"` + `useT(restaurantesPedidos)`), nunca en el de arranque. Aqui solo van sus TIPOS, que
 * `mensajes/index.ts` suma a `Clave`; su ingles va en `en/restaurantes/` (`MODULOS_EN_RESTAURANTES`).
 *
 * No va en el catalogo: datos del negocio (productos, clientes, sucursales), lo que genera la IA y lo que el agente le dice al
 * cliente final por WhatsApp o voz.
 */
import type { restaurantesComun } from "./comun.ts";
import type { restaurantesPedidos } from "./pedidos.ts";
import type { restaurantesResumen } from "./resumen.ts";

export interface ModulosRestaurantes {
  readonly restaurantesComun: typeof restaurantesComun;
  readonly restaurantesPedidos: typeof restaurantesPedidos;
  readonly restaurantesResumen: typeof restaurantesResumen;
}
