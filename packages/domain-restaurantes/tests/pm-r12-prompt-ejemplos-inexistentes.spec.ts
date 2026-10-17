// PM R12 (T7-008): el prompt de PM daba como ejemplo de "producto que NO existe en el menu" a "queso fundido" y a "frijoles charros especiales",
// pero el menu sembrado SI los tiene (5 quesos fundidos y 3 charros especiales). El agente negaba el producto y luego lo cotizaba y cobraba:
// afirmacion falsa al cliente. Esta prueba ata que NINGUN ejemplo de "no existe / no lo manejamos" del prompt sea un producto real del menu.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../src/types.ts";

const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const SEED = JSON.parse(readFileSync(new URL("../../../scripts/seed-pm-demo/data/pm-seed-data.json", import.meta.url), "utf8")) as { productos: { nombre: string }[] };
const NOMBRES_MENU = SEED.productos.map((p) => norm(p.nombre));

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

/** Ejemplos que el prompt presenta como inexistentes: listas entre parentesis tras las dos frases que las introducen. */
function ejemplosDeInexistentes(texto: string): string[] {
  const out: string[] = [];
  for (const re of [/NO existe en el menú \(buscar_producto sin resultado: ([^)]*)\)/g, /productos que no manejamos \(([^)]*)\)/g]) {
    for (const m of texto.matchAll(re)) {
      const lista = m[1] ?? "";
      const entrecomillados = [...lista.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
      out.push(...(entrecomillados.length > 0 ? entrecomillados : lista.split(",").map((x) => x.trim()).filter(Boolean)));
    }
  }
  return out;
}

/** Productos del menu cuyo nombre contiene el ejemplo como palabra(s) completas. */
function choques(ejemplo: string): string[] {
  const e = ` ${norm(ejemplo)} `;
  return NOMBRES_MENU.filter((n) => ` ${n} `.includes(e));
}

describe("PM R12: los ejemplos de producto inexistente del prompt no existen en el menu sembrado", () => {
  const ejemplos = ejemplosDeInexistentes(prompt);

  it("el extractor encuentra las dos listas de ejemplos (la prueba no es vacia)", () => {
    expect(ejemplos).toContain("dedos de queso");
    expect(ejemplos).toContain("longaniza");
    expect(ejemplos.length).toBeGreaterThanOrEqual(6);
  });

  it("ningun ejemplo de inexistente coincide con un nombre del menu", () => {
    const malos = ejemplos.map((e) => ({ ejemplo: e, menu: choques(e) })).filter((x) => x.menu.length > 0);
    expect(malos).toEqual([]);
  });

  it("regresion T7-008: «queso fundido» y «frijoles charros especiales» existen en el menu, asi que no pueden ser ejemplo de inexistente", () => {
    expect(choques("queso fundido").length).toBeGreaterThanOrEqual(5);
    expect(choques("frijoles charros especiales").length).toBeGreaterThanOrEqual(1);
    expect(ejemplos.map(norm)).not.toContain("queso fundido");
    expect(ejemplos.map(norm)).not.toContain("frijoles charros especiales");
  });

  it("el ejemplo de reemplazo (sushi) y los de fuera de catalogo siguen sin existir en el menu", () => {
    for (const e of ["sushi", "dedos de queso", "chistorra", "longaniza", "salchichas", "bbq", "chipotle"]) expect(choques(e)).toEqual([]);
  });
});
