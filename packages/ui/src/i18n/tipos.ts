/**
 * Tipos del catalogo de traducciones (ES/EN). Un mensaje es un texto con `{variables}` o, si depende de una cantidad, un objeto
 * de plurales con las categorias de `Intl.PluralRules` (`other` siempre obligatoria). Los modulos se declaran con
 * `definirModulo`: el ingles DEBE tener exactamente las mismas claves que el espanol, asi que una clave que falta (o que sobra)
 * rompe el typecheck en lugar de llegar a produccion en espanol a medias.
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

export interface Modulo<ES extends Readonly<Record<string, Mensaje>>> {
  readonly es: ES;
  readonly en: { readonly [K in keyof ES]: Mensaje };
}

/**
 * Declara un modulo del catalogo. Uso:
 *
 *   export const nav = definirModulo({ es: { "nav.resumen": "Resumen" }, en: { "nav.resumen": "Overview" } });
 *
 * - Falta una clave en `en` -> error de tipos (propiedad requerida).
 * - Sobra una clave en `en` -> error de tipos (propiedad en exceso del literal).
 * Convencion: todas las claves de un modulo llevan su prefijo (`nav.`, `comun.`, ...); una prueba exige que no se repitan entre modulos.
 */
export function definirModulo<const ES extends Readonly<Record<string, Mensaje>>>(modulo: {
  readonly es: ES;
  readonly en: { readonly [K in keyof ES]: Mensaje };
}): Modulo<ES> {
  return modulo;
}
