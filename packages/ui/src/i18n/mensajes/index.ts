/**
 * Catalogo completo ES/EN. Cada area vive en su propio modulo y se registra aqui con UNA linea en `MODULOS` (espanol, la fuente)
 * y otra en `en/catalogo-en.ts` (`MODULOS_EN`, su traduccion): asi varios carriles (shell, recorrido guiado, chat de datos...) agregan
 * textos sin pisarse. `Clave` es la union de todas las claves: `t("nav.resumne")` no compila.
 *
 * Carga: el espanol de `MODULOS` va en el bundle de arranque y el de cada area (`ModulosDeArea`) con el chunk de quien lo
 * importa; el ingles completo es un chunk aparte que se pide la primera vez que se elige EN (`cargarIdioma`). Mientras llega,
 * todo sigue en espanol (nunca una clave cruda).
 *
 * Que NO va en el catalogo: datos del cliente (nombres, productos del menu, direcciones), texto que genera la IA y todo lo que
 * el agente le dice al consumidor final por WhatsApp o voz (eso sigue en espanol, lo decide el negocio, no la consola).
 */
import type { Idioma, Mensaje, Traduccion } from "../tipos.ts";
import type { comun } from "./comun.ts";
import type { consola } from "./consola.ts";
import type { datos } from "./datos.ts";
import type { nav } from "./nav.ts";
import type { notif } from "./notif.ts";
import type { rol } from "./rol.ts";
import type { shell } from "./shell.ts";
import type { waMeta } from "./waMeta.ts";

/**
 * Modulos que van en el bundle de arranque. Vacio a proposito: la entrada esta en su tope de bundle, asi que TODO modulo es
 * de area y viaja con el chunk de quien lo importa.
 */
export const MODULOS = {} as const;

/**
 * Modulos de un area: viajan en el chunk de quien los usa (`import { <area> } from "@atiende/ui/i18n/<area>"`) y no en el de
 * arranque. Aqui solo se declaran sus TIPOS
 * (`readonly <area>: typeof <area>` con `import type`). Quien lo usa lo pasa a `useT(<area>)` / `useI18n(<area>)`, que registra su
 * espanol en el render (fuera de React: `registrarModuloEs(<area>)`). El archivo del modulo NO tiene efectos al importarse.
 */
interface ModulosDeArea {
  readonly comun: typeof comun;
  readonly nav: typeof nav;
  readonly shell: typeof shell;
  readonly rol: typeof rol;
  readonly consola: typeof consola;
  readonly notif: typeof notif;
  readonly datos: typeof datos;
  readonly waMeta: typeof waMeta;
}

type Modulos = typeof MODULOS & ModulosDeArea;
type UnionAInterseccion<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type CatalogoEs = UnionAInterseccion<Modulos[keyof Modulos]>;

export type Clave = Extract<keyof CatalogoEs, string>;
export type Catalogo = Readonly<Record<Clave, Mensaje>>;
/** Forma que debe cumplir `MODULOS_EN`: cada modulo con su traduccion completa. */
export type ModulosTraducidos = { readonly [K in keyof Modulos]: Traduccion<Modulos[K]> };

const juntar = (modulos: Readonly<Record<string, Readonly<Record<string, Mensaje>>>>): Catalogo => Object.assign({}, ...Object.values(modulos)) as Catalogo;

export const CATALOGO_ES: Catalogo = juntar(MODULOS);

/** Lo llama cada modulo de area al importarse: suma su espanol al catalogo (idempotente). */
export function registrarModuloEs(modulo: Readonly<Record<string, Mensaje>>): void {
  Object.assign(CATALOGO_ES, modulo);
}
let catalogoEn: Catalogo | null = null;
let cargaEn: Promise<void> | null = null;

/** Catalogo ya disponible del idioma (`null` si el ingles aun no se descarga). */
export function catalogoDe(idioma: Idioma): Catalogo | null {
  return idioma === "es" ? CATALOGO_ES : catalogoEn;
}

export function idiomaListo(idioma: Idioma): boolean {
  return catalogoDe(idioma) !== null;
}

/** Descarga (una sola vez) el catalogo del idioma. El espanol ya esta. Un fallo de red deja reintentar en el siguiente cambio. */
export function cargarIdioma(idioma: Idioma): Promise<void> {
  if (idioma === "es" || catalogoEn) return Promise.resolve();
  cargaEn ??= import("./en/catalogo-en.ts").then(
    (m) => {
      catalogoEn = juntar(m.MODULOS_EN);
    },
    (e: unknown) => {
      cargaEn = null;
      throw e;
    },
  );
  return cargaEn;
}
