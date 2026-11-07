/**
 * Paginas de rentas (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/rentas/<modulo>.ts`, con claves `rentas.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/rentas/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosRentasBase } from "./grupos/base.ts";
import type { ModulosRentasOperacion } from "./grupos/operacion.ts";
import type { ModulosRentasFinanzas } from "./grupos/finanzas.ts";
import type { ModulosRentasAjustes } from "./grupos/ajustes.ts";

export type ModulosRentas = ModulosRentasBase &
  ModulosRentasOperacion &
  ModulosRentasFinanzas &
  ModulosRentasAjustes;
