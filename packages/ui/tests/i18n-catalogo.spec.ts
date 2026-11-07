// i18n ES/EN: salud del catalogo. Las claves faltantes ya las detiene el typecheck (ver i18n-tipos.spec.ts); aqui se cuida lo que
// el tipo no ve: claves repetidas entre modulos, variables que no coinciden, plurales sin `other` y — lo que Rovaq deja pasar —
// textos en «ingles» que en realidad se quedaron en espanol.
import { readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { MODULOS_EN } from "../src/i18n/mensajes/en/catalogo-en.ts";
import type { Mensaje } from "../src/i18n/tipos.ts";

type Mod = { es: Record<string, Mensaje>; en: Record<string, Mensaje> };
// Todos los modulos en espanol, de arranque y de area: cada archivo de `mensajes/` exporta una constante con su nombre. Las
// paginas de una vertical viven en una subcarpeta (`mensajes/restaurantes/pedidos.ts` exporta `restaurantesPedidos`, con claves
// `restaurantes.*`): su prefijo es el de la carpeta.
const carpeta = new URL("../src/i18n/mensajes/", import.meta.url);
const SUBCARPETAS = readdirSync(carpeta, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "en")
  .map((d) => d.name);
const archivos = [
  ...readdirSync(carpeta).filter((f) => f.endsWith(".ts") && f !== "index.ts"),
  ...SUBCARPETAS.flatMap((sub) => readdirSync(new URL(`${sub}/`, carpeta)).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => `${sub}/${f}`)),
];
const nombreDe = (f: string): string => {
  const [sub, archivo] = f.replace(/\.ts$/, "").split("/") as [string, string | undefined];
  return archivo === undefined ? sub : `${sub}${archivo.charAt(0).toUpperCase()}${archivo.slice(1)}`;
};
const prefijoDe = new Map<string, string>(archivos.map((f) => [nombreDe(f), f.includes("/") ? (f.split("/")[0] as string) : nombreDe(f)]));
const ES: Record<string, Record<string, Mensaje>> = {};
let modulos: Array<[string, Mod]> = [];
const CATALOGOS: { es: Record<string, Mensaje>; en: Record<string, Mensaje> } = { es: {}, en: {} };

beforeAll(async () => {
  for (const f of archivos) {
    const nombre = nombreDe(f);
    const m = (await import(new URL(f, carpeta).href)) as Record<string, Record<string, Mensaje>>;
    ES[nombre] = m[nombre] ?? {};
  }
  const en = MODULOS_EN as unknown as Record<string, Record<string, Mensaje>>;
  modulos = Object.keys(ES).map((k): [string, Mod] => [k, { es: ES[k] ?? {}, en: en[k] ?? {} }]);
  CATALOGOS.es = Object.assign({}, ...Object.values(ES));
  CATALOGOS.en = Object.assign({}, ...Object.values(en));
});

const textos = (m: Mensaje | undefined): string[] => (m === undefined ? [] : typeof m === "string" ? [m] : Object.values(m).filter((v): v is string => typeof v === "string"));
const variables = (m: Mensaje | undefined): string[] => [...new Set(textos(m).flatMap((t) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1] ?? "")))].sort();

/**
 * Textos que son iguales en los dos idiomas a proposito (nombres propios, siglas, la propia etiqueta del idioma). Agregar aqui
 * exige que la palabra realmente se diga igual en ingles; si no, traducela.
 */
const IGUALES_PERMITIDOS = new Set<string>([
  "Español (ES)",
  "English (EN)",
  // Zonas horarias: nombre propio de la ciudad + su id IANA.
  "Tijuana (America/Tijuana)",
  "Chihuahua (America/Chihuahua)",
  "Hermosillo (America/Hermosillo)",
  "Meta (WhatsApp Business)",


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
  // Paginas de restaurantes: terminos que en ingles se escriben igual.
  "Web",
  "POS",
  "Subtotal",
  "Total",
  "{min} min",
]);

describe("catalogo i18n", () => {
  it("hay traduccion para cada modulo y ninguna de mas", () => {
    expect(Object.keys(MODULOS_EN).sort()).toEqual(Object.keys(ES).sort());
  });

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
        const prefijo = prefijoDe.get(nombre) ?? nombre;
        expect(clave.startsWith(`${prefijo}.`), `«${clave}» deberia empezar con «${prefijo}.»`).toBe(true);

      }
    }
    expect(Object.keys(CATALOGOS.es).length).toBe(vistas.size);
  });

  it("las {variables} coinciden entre idiomas", () => {
    for (const clave of Object.keys(CATALOGOS.es) as string[]) {
      expect(variables(CATALOGOS.en[clave]), String(clave)).toEqual(variables(CATALOGOS.es[clave]));
    }
  });

  it("todo plural trae `other` y es plural en los dos idiomas", () => {
    for (const clave of Object.keys(CATALOGOS.es) as string[]) {
      const es = CATALOGOS.es[clave];
      const en = CATALOGOS.en[clave];
      expect(en, String(clave)).toBeDefined();
      expect(typeof es === "string", String(clave)).toBe(typeof en === "string");
      if (es !== undefined && typeof es !== "string") expect(es.other, String(clave)).toBeTruthy();
      if (en !== undefined && typeof en !== "string") expect(en.other, String(clave)).toBeTruthy();
    }
  });

  it("ningun texto en ingles se quedo en espanol (identico o con acentos/ñ/¿¡)", () => {
    const sospechosos: string[] = [];
    for (const clave of Object.keys(CATALOGOS.es) as string[]) {
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
