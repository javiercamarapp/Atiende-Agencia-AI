/**
 * Tipos del catalogo de traducciones (ES/EN). Un mensaje es un texto con `{variables}` o, si depende de una cantidad, un objeto
 * de plurales con las categorias de `Intl.PluralRules` (`other` siempre obligatoria). Cada modulo en espanol tiene su
 * `Traduccion` al ingles con exactamente las mismas claves: una clave que falta (o que sobra) rompe el typecheck en lugar de
 * llegar a produccion en espanol a medias.
 */
/** Mismo tipo que `Idioma` de lib/idioma (la preferencia); repetido aqui para que el nucleo no dependa de `window`. */
export type Idioma = "es" | "en";

export interface Plural {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Mensaje = string | Plural;

/** Valores para `{variable}`. Un numero se formatea con el locale activo (1,234 / 1,234); `count` ademas elige el plural. */
export type Variables = Readonly<Record<string, string | number>>;

/** Un modulo del catalogo en espanol (la fuente): `{ "area.clave": "Texto" }`, declarado `as const satisfies ModuloEs`. */
export type ModuloEs = Readonly<Record<string, Mensaje>>;

/**
 * La traduccion de un modulo: EXACTAMENTE las mismas claves que el espanol. Uso (archivo aparte en `mensajes/en/`):
 *
 *   export const navEn: Traduccion<typeof nav> = { "nav.resumen": "Overview" };
 *
 * - Falta una clave -> error de tipos (propiedad requerida).
 * - Sobra una clave -> error de tipos (propiedad en exceso del literal).
 * El ingles va en su propio archivo para que viaje en un chunk aparte (carga perezosa): el espanol, idioma por omision, es el
 * unico que entra al bundle de arranque.
 */
export type Traduccion<ES extends ModuloEs> = { readonly [K in keyof ES]: Mensaje };
