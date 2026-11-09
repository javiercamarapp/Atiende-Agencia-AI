/**
 * Paginas de superadmin (i18n ES/EN): un modulo por pantalla o grupo de pantallas en `mensajes/superadmin/<modulo>.ts`, con claves `superadmin.<modulo>.*`, que
 * viaja en el chunk de la pagina que lo usa (`useT(<modulo>)`). Aqui solo van sus TIPOS, por grupo (`grupos/<grupo>.ts`: un PR por grupo,
 * sin chocar); su ingles en `en/superadmin/`. Mismo patron que `mensajes/restaurantes/`.
 */
import type { ModulosSuperadminBase } from "./grupos/base.ts";
import type { ModulosSuperadminComercial } from "./grupos/comercial.ts";
import type { ModulosSuperadminCostos } from "./grupos/costos.ts";
import type { ModulosSuperadminSeguridad } from "./grupos/seguridad.ts";
import type { ModulosSuperadminAgentes } from "./grupos/agentes.ts";

export type ModulosSuperadmin = ModulosSuperadminBase &
  ModulosSuperadminComercial &
  ModulosSuperadminCostos &
  ModulosSuperadminSeguridad &
  ModulosSuperadminAgentes;
