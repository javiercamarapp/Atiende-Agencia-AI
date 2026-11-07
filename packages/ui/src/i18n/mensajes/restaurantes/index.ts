/**
 * Paginas de restaurantes (i18n ES/EN). Un modulo por pantalla o grupo de pantallas, con claves `restaurantes.<modulo>.*`.
 * Cada modulo es de AREA: viaja en el chunk de la pagina que lo usa (`import { restaurantesPedidos } from
 * "@atiende/ui/i18n/restaurantes/pedidos"` + `useT(restaurantesPedidos)`), nunca en el de arranque. Aqui solo van sus TIPOS, por grupo
 * (`grupos/<grupo>.ts`: un PR por grupo, sin chocar), que `mensajes/index.ts` suma a `Clave`; su ingles va en `en/restaurantes/` (`MODULOS_EN_RESTAURANTES`).
 *
 * No va en el catalogo: datos del negocio (productos, clientes, sucursales), lo que genera la IA y lo que el agente le dice al
 * cliente final por WhatsApp o voz.
 */
import type { ModulosRestaurantesBase } from "./grupos/base.ts";
import type { ModulosRestaurantesAutopiloto } from "./grupos/autopiloto.ts";
import type { ModulosRestaurantesOperacion } from "./grupos/operacion.ts";
import type { ModulosRestaurantesCatalogo } from "./grupos/catalogo.ts";
import type { ModulosRestaurantesClientes } from "./grupos/clientes.ts";
import type { ModulosRestaurantesAgente } from "./grupos/agente.ts";
import type { ModulosRestaurantesCfo } from "./grupos/cfo.ts";
import type { ModulosRestaurantesAjustes } from "./grupos/ajustes.ts";

export type ModulosRestaurantes = ModulosRestaurantesBase &
  ModulosRestaurantesAutopiloto &
  ModulosRestaurantesOperacion &
  ModulosRestaurantesCatalogo &
  ModulosRestaurantesClientes &
  ModulosRestaurantesAgente &
  ModulosRestaurantesCfo &
  ModulosRestaurantesAjustes;
