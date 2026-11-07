import { CATALOGO_ES, catalogoDe, type Clave } from "./mensajes/index.ts";
import { LOCALE_POR_IDIOMA, type Idioma, type Mensaje, type Plural, type Variables } from "./tipos.ts";

// Intl minimo para `t` (plural y numeros en variables); el formato completo vive en formato.ts (`useFormatos`).
const plurales = /* @__PURE__ */ new Map<Idioma, Intl.PluralRules>();
const numeros = /* @__PURE__ */ new Map<Idioma, Intl.NumberFormat>();
const conCache = <T>(m: Map<Idioma, T>, idioma: Idioma, crear: (locale: string) => T): T => {
  let v = m.get(idioma);
  if (!v) m.set(idioma, (v = crear(LOCALE_POR_IDIOMA[idioma])));
  return v;
};

/** Firma de `t`: clave tipada + variables opcionales. Para plurales pasa `{ count }`. */
export type Traductor = (clave: Clave, variables?: Variables) => string;

function elegirPlural(idioma: Idioma, plural: Plural, count: number | undefined): string {
  if (count === undefined) return plural.other;
  if (count === 0 && plural.zero !== undefined) return plural.zero;
  const categoria = conCache(plurales, idioma, (l) => new Intl.PluralRules(l)).select(count) as keyof Plural;
  return plural[categoria] ?? plural.other;
}

/**
 * Traduce sin React (servicios, pruebas, `document.title`). Orden de respaldo: idioma pedido (si su catalogo ya se descargo,
 * ver `cargarIdioma`) -> espanol -> la propia clave
 * (visible a proposito: con claves tipadas no deberia pasar nunca, y si pasa se nota en vez de dejar un hueco).
 * `{variable}` se reemplaza; en ingles los numeros salen con su formato (1,234) y en espanol tal cual, como el texto que
 * reemplazan (1234), para no cambiar ni un byte de lo que ya se ve. Una variable que no llego se deja
 * tal cual (`{nombre}`) para que el error se vea en pantalla y en las pruebas.
 */
export function traducir(idioma: Idioma, clave: Clave, variables?: Variables): string {
  const mensaje: Mensaje | undefined = catalogoDe(idioma)?.[clave] ?? CATALOGO_ES[clave];
  if (mensaje === undefined) return clave;
  const count = typeof variables?.["count"] === "number" ? (variables["count"] as number) : undefined;
  const texto = typeof mensaje === "string" ? mensaje : elegirPlural(idioma, mensaje, count);
  if (!variables) return texto;
  return texto.replace(/\{(\w+)\}/g, (completo, nombre: string) => {
    const valor = variables[nombre];
    if (valor === undefined) return completo;
    if (typeof valor !== "number") return valor;
    // En espanol el numero sale tal cual (como el texto que reemplaza: byte a byte igual); en ingles, con su formato (1,234).
    return idioma === "es" ? String(valor) : conCache(numeros, idioma, (l) => new Intl.NumberFormat(l)).format(valor);
  });
}

export const crearTraductor = (idioma: Idioma): Traductor => (clave, variables) => traducir(idioma, clave, variables);
