import { crearFormatos, reglaPlural } from "./formato.ts";
import { CATALOGOS, type Clave } from "./mensajes/index.ts";
import type { Idioma, Mensaje, Plural, Variables } from "./tipos.ts";

/** Firma de `t`: clave tipada + variables opcionales. Para plurales pasa `{ count }`. */
export type Traductor = (clave: Clave, variables?: Variables) => string;

function elegirPlural(idioma: Idioma, plural: Plural, count: number | undefined): string {
  if (count === undefined) return plural.other;
  if (count === 0 && plural.zero !== undefined) return plural.zero;
  const categoria = reglaPlural(idioma).select(count) as keyof Plural;
  return plural[categoria] ?? plural.other;
}

/**
 * Traduce sin React (servicios, pruebas, `document.title`). Orden de respaldo: idioma pedido -> espanol -> la propia clave
 * (visible a proposito: con claves tipadas no deberia pasar nunca, y si pasa se nota en vez de dejar un hueco).
 * `{variable}` se reemplaza; los numeros salen con el formato del idioma (1,234 / 1,234). Una variable que no llego se deja
 * tal cual (`{nombre}`) para que el error se vea en pantalla y en las pruebas.
 */
export function traducir(idioma: Idioma, clave: Clave, variables?: Variables): string {
  const mensaje: Mensaje | undefined = CATALOGOS[idioma][clave] ?? CATALOGOS.es[clave];
  if (mensaje === undefined) return clave;
  const count = typeof variables?.["count"] === "number" ? (variables["count"] as number) : undefined;
  const texto = typeof mensaje === "string" ? mensaje : elegirPlural(idioma, mensaje, count);
  if (!variables) return texto;
  const formatos = crearFormatos(idioma);
  return texto.replace(/\{(\w+)\}/g, (completo, nombre: string) => {
    const valor = variables[nombre];
    if (valor === undefined) return completo;
    return typeof valor === "number" ? formatos.numero(valor) : valor;
  });
}

export const crearTraductor = (idioma: Idioma): Traductor => (clave, variables) => traducir(idioma, clave, variables);
