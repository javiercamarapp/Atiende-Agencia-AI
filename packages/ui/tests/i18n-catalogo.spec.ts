// i18n ES/EN: salud del catalogo. Las claves faltantes ya las detiene el typecheck (ver i18n-tipos.spec.ts); aqui se cuida lo que
// el tipo no ve: claves repetidas entre modulos, variables que no coinciden, plurales sin `other` y — lo que Rovaq deja pasar —
// textos en «ingles» que en realidad se quedaron en espanol.
import { describe, expect, it } from "vitest";
import { CATALOGOS, MODULOS } from "../src/i18n/mensajes/index.ts";
import type { Mensaje } from "../src/i18n/tipos.ts";

type Mod = { es: Record<string, Mensaje>; en: Record<string, Mensaje> };
const modulos = Object.entries(MODULOS) as Array<[string, Mod]>;

const textos = (m: Mensaje): string[] => (typeof m === "string" ? [m] : Object.values(m).filter((v): v is string => typeof v === "string"));
const variables = (m: Mensaje): string[] => [...new Set(textos(m).flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1] ?? "")))].sort();

/**
 * Textos que son iguales en los dos idiomas a proposito (nombres propios, siglas, la propia etiqueta del idioma). Agregar aqui
 * exige que la palabra realmente se diga igual en ingles; si no, traducela.
 */
const IGUALES_PERMITIDOS = new Set<string>([
  "Español (ES)",
  "English (EN)",
  // Siglas y nombres propios que se dicen igual en ingles.
  "CFO",
  "CFDI",
  "P&L",
  "WhatsApp",
  "Model Ops",
  "Orgs",
  "Radar",
  "{vertical} · {nombre}",
  // Prestamos del ingles que el espanol de la consola ya usa tal cual.
  "Staff",
  "Housekeeping",
  "Bookkeeping",
  "Revenue",
  "Tickets",
  "Auditor",
]);

describe("catalogo i18n", () => {
  it("cada modulo tiene las mismas claves en es y en", () => {
    for (const [nombre, m] of modulos) {
      expect(Object.keys(m.en).sort(), nombre).toEqual(Object.keys(m.es).sort());
    }
  });

  it("ninguna clave se repite entre modulos y todas llevan el prefijo de su modulo", () => {
    const vistas = new Map<string, string>();
    for (const [nombre, m] of modulos) {
      for (const clave of Object.keys(m.es)) {
        expect(vistas.get(clave), `«${clave}» esta en ${vistas.get(clave)} y en ${nombre}`).toBeUndefined();
        vistas.set(clave, nombre);
        expect(clave.startsWith(`${nombre}.`), `«${clave}» deberia empezar con «${nombre}.»`).toBe(true);
      }
    }
    expect(Object.keys(CATALOGOS.es).length).toBe(vistas.size);
  });

  it("las {variables} coinciden entre idiomas", () => {
    for (const clave of Object.keys(CATALOGOS.es) as Array<keyof typeof CATALOGOS.es>) {
      expect(variables(CATALOGOS.en[clave]), String(clave)).toEqual(variables(CATALOGOS.es[clave]));
    }
  });

  it("todo plural trae `other` y es plural en los dos idiomas", () => {
    for (const clave of Object.keys(CATALOGOS.es) as Array<keyof typeof CATALOGOS.es>) {
      const es = CATALOGOS.es[clave];
      const en = CATALOGOS.en[clave];
      expect(typeof es === "string", String(clave)).toBe(typeof en === "string");
      if (typeof es !== "string") expect(es.other, String(clave)).toBeTruthy();
      if (typeof en !== "string") expect(en.other, String(clave)).toBeTruthy();
    }
  });

  it("ningun texto en ingles se quedo en espanol (identico o con acentos/ñ/¿¡)", () => {
    const sospechosos: string[] = [];
    for (const clave of Object.keys(CATALOGOS.es) as Array<keyof typeof CATALOGOS.es>) {
      const es = textos(CATALOGOS.es[clave]);
      for (const [i, en] of textos(CATALOGOS.en[clave]).entries()) {
        if (IGUALES_PERMITIDOS.has(en)) continue;
        if (/[áéíóúñ¿¡]/i.test(en)) sospechosos.push(`${String(clave)}: «${en}» tiene caracteres del espanol`);
        else if (en === es[i] && /[a-z]{3,}/i.test(en)) sospechosos.push(`${String(clave)}: «${en}» es igual en espanol`);
      }
    }
    expect(sospechosos).toEqual([]);
  });

  it("ningun texto vacio", () => {
    for (const idioma of ["es", "en"] as const) {
      for (const [clave, m] of Object.entries(CATALOGOS[idioma])) {
        for (const t of textos(m)) expect(t.trim().length, `${idioma} ${clave}`).toBeGreaterThan(0);
      }
    }
  });
});
