/**
 * Paginas de citas (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/citas/<modulo>.ts`, con claves `citas.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/citas/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosCitasBase } from "./grupos/base.ts";
import type { ModulosCitasOperacion } from "./grupos/operacion.ts";
import type { ModulosCitasFinanzas } from "./grupos/finanzas.ts";
import type { ModulosCitasAjustes } from "./grupos/ajustes.ts";

export type ModulosCitas = ModulosCitasBase &
  ModulosCitasOperacion &
  ModulosCitasFinanzas &
  ModulosCitasAjustes;
