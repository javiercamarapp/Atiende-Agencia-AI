/**
 * Paginas de despachos (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/despachos/<modulo>.ts`, con claves `despachos.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/despachos/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosDespachosBase } from "./grupos/base.ts";
import type { ModulosDespachosOperacion } from "./grupos/operacion.ts";
import type { ModulosDespachosFinanzas } from "./grupos/finanzas.ts";
import type { ModulosDespachosAjustes } from "./grupos/ajustes.ts";

export type ModulosDespachos = ModulosDespachosBase &
  ModulosDespachosOperacion &
  ModulosDespachosFinanzas &
  ModulosDespachosAjustes;
