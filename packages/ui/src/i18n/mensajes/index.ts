/**
 * Catalogo completo ES/EN. Cada area vive en su propio modulo (`definirModulo`) y se registra aqui con UNA linea en `MODULOS`:
 * asi varios carriles (shell, recorrido guiado, chat de datos...) agregan textos sin pisarse. `Clave` es la union de todas las
 * claves: `t("nav.resumne")` no compila.
 *
 * Que NO va en el catalogo: datos del cliente (nombres, productos del menu, direcciones), texto que genera la IA y todo lo que
 * el agente le dice al consumidor final por WhatsApp o voz (eso sigue en espanol, lo decide el negocio, no la consola).
 */
import type { Mensaje } from "../tipos.ts";
import { comun } from "./comun.ts";

export const MODULOS = {
  comun,
} as const;

type Modulos = typeof MODULOS;
type UnionAInterseccion<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type CatalogoEs = UnionAInterseccion<Modulos[keyof Modulos]["es"]>;

export type Clave = Extract<keyof CatalogoEs, string>;
export type Catalogo = Readonly<Record<Clave, Mensaje>>;

function juntar(idioma: "es" | "en"): Catalogo {
  const salida: Record<string, Mensaje> = {};
  for (const modulo of Object.values(MODULOS) as ReadonlyArray<{ es: Record<string, Mensaje>; en: Record<string, Mensaje> }>) {
    Object.assign(salida, modulo[idioma]);
  }
  return salida as Catalogo;
}

export const CATALOGOS: Readonly<Record<"es" | "en", Catalogo>> = { es: juntar("es"), en: juntar("en") };
