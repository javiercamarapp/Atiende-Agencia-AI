/**
 * Catalogo completo ES/EN. Cada area vive en su propio modulo y se registra aqui con UNA linea en `MODULOS` (espanol, la fuente)
 * y otra en `en/index.ts` (`MODULOS_EN`, su traduccion): asi varios carriles (shell, recorrido guiado, chat de datos...) agregan
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
import { comun } from "./comun.ts";

/** Modulos que van en el bundle de arranque (los usan componentes de cualquier pantalla). */
export const MODULOS = {
  comun,
} as const;

/**
 * Modulos de un area: su espanol se registra solo cuando se importa su archivo (`import "@atiende/ui/i18n/<area>"` en quien lo
 * usa), asi viaja en el chunk perezoso de esa area y no en el de arranque. Aqui solo se declaran sus TIPOS
 * (`readonly <area>: typeof <area>` con `import type`). Cada archivo de area termina con `registrarModuloEs(<area>)`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- se llena con los modulos de area
interface ModulosDeArea {}

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
  cargaEn ??= import("./en/index.ts").then(
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
