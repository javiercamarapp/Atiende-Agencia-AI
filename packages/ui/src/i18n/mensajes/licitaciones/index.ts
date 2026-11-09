/**
 * Paginas de licitaciones (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/licitaciones/<modulo>.ts`, con claves `licitaciones.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/licitaciones/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosLicitacionesBase } from "./grupos/base.ts";
import type { ModulosLicitacionesOperacion } from "./grupos/operacion.ts";
import type { ModulosLicitacionesFinanzas } from "./grupos/finanzas.ts";
import type { ModulosLicitacionesAjustes } from "./grupos/ajustes.ts";

export type ModulosLicitaciones = ModulosLicitacionesBase &
  ModulosLicitacionesOperacion &
  ModulosLicitacionesFinanzas &
  ModulosLicitacionesAjustes;
