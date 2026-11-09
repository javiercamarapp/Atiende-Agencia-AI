/**
 * Paginas de hoteles (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/hoteles/<modulo>.ts`, con claves `hoteles.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/hoteles/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosHotelesBase } from "./grupos/base.ts";
import type { ModulosHotelesOperacion } from "./grupos/operacion.ts";
import type { ModulosHotelesFinanzas } from "./grupos/finanzas.ts";
import type { ModulosHotelesAjustes } from "./grupos/ajustes.ts";

export type ModulosHoteles = ModulosHotelesBase &
  ModulosHotelesOperacion &
  ModulosHotelesFinanzas &
  ModulosHotelesAjustes;
