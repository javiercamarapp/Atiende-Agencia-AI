/**
 * Catalogo completo ES/EN. Cada area vive en su propio modulo y se registra aqui con UNA linea en `MODULOS` (espanol, la fuente)
 * y otra en `en/index.ts` (`MODULOS_EN`, su traduccion): asi varios carriles (shell, recorrido guiado, chat de datos...) agregan
 * textos sin pisarse. `Clave` es la union de todas las claves: `t("nav.resumne")` no compila.
 *
 * Carga: el espanol (idioma por omision) va en el bundle de arranque; el ingles es un chunk aparte que se pide la primera vez
 * que se elige EN (`cargarIdioma`). Mientras llega, todo sigue en espanol (nunca una clave cruda).
 *
 * Que NO va en el catalogo: datos del cliente (nombres, productos del menu, direcciones), texto que genera la IA y todo lo que
 * el agente le dice al consumidor final por WhatsApp o voz (eso sigue en espanol, lo decide el negocio, no la consola).
 */
import type { Idioma, Mensaje, Traduccion } from "../tipos.ts";
import { comun } from "./comun.ts";

export const MODULOS = {
  comun,
} as const;

type Modulos = typeof MODULOS;
type UnionAInterseccion<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type CatalogoEs = UnionAInterseccion<Modulos[keyof Modulos]>;

export type Clave = Extract<keyof CatalogoEs, string>;
export type Catalogo = Readonly<Record<Clave, Mensaje>>;
/** Forma que debe cumplir `MODULOS_EN`: cada modulo con su traduccion completa. */
export type ModulosTraducidos = { readonly [K in keyof Modulos]: Traduccion<Modulos[K]> };

const juntar = (modulos: Readonly<Record<string, Readonly<Record<string, Mensaje>>>>): Catalogo => Object.assign({}, ...Object.values(modulos)) as Catalogo;

export const CATALOGO_ES: Catalogo = juntar(MODULOS);
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
