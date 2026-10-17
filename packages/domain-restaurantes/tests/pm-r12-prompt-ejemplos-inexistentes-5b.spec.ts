// PM R12 (seguimiento de #589): el paso 5b del prompt de PM decia «Si pide algo que NO esta en el menu (pizza, ...) ... "pizza no la manejamos"»,
// pero el menu sembrado tiene 8 productos de la categoria «Pizza Quesobich» (alias «pizza»). Un cliente que pidiera «pizza» recibia un «no la manejamos» falso.
// Esta prueba generaliza la de #589 (que solo cubria dos listas): extrae los ejemplos de CUALQUIER frase del prompt armado que cite un producto
// como inexistente («NO esta en el menu», «no la/lo manejamos», «no manejamos», «no tenemos», «no vendemos», «NO existe»), entre parentesis o entre comillas,
// y exige que ninguno coincida con un nombre, alias o categoria del seed (sin acentos, sin mayusculas, singular/plural, palabra completa).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

/** Sin acentos, minusculas, solo alfanumerico, cada palabra en singular simple (quita «s» final de palabras largas). */
const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");

type Producto = { nombre: string; categoria?: string; alias?: string[] };
const SEED = JSON.parse(readFileSync(new URL("../../../scripts/seed-pm-demo/data/pm-seed-data.json", import.meta.url), "utf8")) as {
  productos: Producto[];
  categorias?: (string | { nombre?: string })[];
};
/** Nombres, alias y categorias del seed: todo lo que un cliente puede pedir y el menu reconoce. */
const TERMINOS_MENU = new Set<string>();
for (const p of SEED.productos) {
  TERMINOS_MENU.add(norm(p.nombre));
  if (p.categoria) TERMINOS_MENU.add(norm(p.categoria));
  for (const a of p.alias ?? []) TERMINOS_MENU.add(norm(a));
}
for (const c of SEED.categorias ?? []) TERMINOS_MENU.add(norm(typeof c === "string" ? c : (c.nombre ?? "")));
TERMINOS_MENU.delete("");

const SUCURSALES: BranchSummary[] = [{ propertyId: "p0", slug: "prol-montejo", name: "Prolongación Montejo", address: null }];
const prompt = buildPmSystemPrompt({
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: SUCURSALES,
  entryBranch: null,
  customer: { isNew: true },
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
});

const DISPARADORES = /no est[aá] en el men[uú]|no existe en el men[uú]|no (?:la|lo|las|los) manejamos|no manejamos|no tenemos|no vendemos/gi;

/** Quita de una cita las propias frases disparadoras («pizza no la manejamos» -> «pizza»). */
const sinDisparador = (t: string): string => t.replace(DISPARADORES, " ").replace(/\s+/g, " ").trim();

/** Ejemplos (entre parentesis y entre comillas) de cada oracion del prompt que contiene una frase de «no existe / no lo manejamos». */
function ejemplosDeInexistentes(texto: string): string[] {
  const out: string[] = [];
  const oraciones = texto.split(/(?<=[.!?])\s+|\n/);
  for (const o of oraciones) {
    DISPARADORES.lastIndex = 0;
    if (!DISPARADORES.test(o)) continue;
    for (const m of o.matchAll(/"([^"]+)"/g)) {
      const e = sinDisparador(m[1]!);
      if (e) out.push(e);
    }
    for (const m of o.matchAll(/\(([^()]*)\)/g)) {
      // «(buscar_producto sin resultado: "a", "b")» -> lista tras los dos puntos; «(pizza, otra cosa)» -> lista completa.
      const cuerpo = m[1]!.includes(":") ? m[1]!.slice(m[1]!.indexOf(":") + 1) : m[1]!;
      if (/^\s*"/.test(cuerpo)) continue; // las citas ya se tomaron arriba
      for (const x of cuerpo.split(",")) {
        const e = sinDisparador(x);
        if (e) out.push(e);
      }
    }
  }
  return [...new Set(out)];
}

/** Terminos del menu (nombre, alias o categoria) que contienen el ejemplo como palabra(s) completas; y los de 2+ palabras contenidos en el ejemplo
 *  (la inversa solo con 2+ palabras: «queso» suelto no debe vetar «dedos de queso»). */
function choques(ejemplo: string): string[] {
  const e = ` ${norm(ejemplo)} `;
  if (e.trim() === "") return [];
  return [...TERMINOS_MENU].filter((t) => ` ${t} `.includes(e) || (t.includes(" ") && e.includes(` ${t} `)));
}

describe("PM R12 (5b): ningun ejemplo de «no existe / no lo manejamos» del prompt es producto, alias o categoria del menu", () => {
  const ejemplos = ejemplosDeInexistentes(prompt);

  it("el extractor cubre el paso 5b y las listas ya conocidas (la prueba no es vacia)", () => {
    const n = ejemplos.map(norm);
    for (const esperado of ["dedos de queso", "longaniza", "salchichas", "chistorra", "sushi"]) expect(n).toContain(norm(esperado));
    expect(prompt).toMatch(/Si pide algo que NO está en el menú \(/); // el 5b sigue existiendo con ese formato
    expect(ejemplos.length).toBeGreaterThanOrEqual(8);
  });

  it("ningun ejemplo coincide con nombre, alias o categoria del seed", () => {
    const malos = ejemplos.map((e) => ({ ejemplo: e, menu: choques(e) })).filter((x) => x.menu.length > 0);
    expect(malos).toEqual([]);
  });

  it("regresion: «pizza» es alias y categoria del menu (Pizza Quesobich), asi que no puede ser ejemplo de inexistente", () => {
    expect(choques("pizza").length).toBeGreaterThanOrEqual(1);
    expect(choques("pizzas").length).toBeGreaterThanOrEqual(1);
    expect(ejemplos.map(norm)).not.toContain("pizza");
  });

  it("el ejemplo de reemplazo del 5b sigue sin existir en el menu", () => {
    expect(choques("sushi")).toEqual([]);
  });
});
