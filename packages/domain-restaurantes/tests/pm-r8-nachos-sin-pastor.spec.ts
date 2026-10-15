// Caso grave R8: «nachos sin pastor» es nachos SIN el ingrediente pastor. Prueba determinista (sin LLM, menu sembrado en memoria): la busqueda nunca devuelve
// «Nachos de Pastor» cuando el pastor se resta, siempre marca `ambiguo` (el agente debe confirmar la suposicion) y el pedido rechaza un nombre inventado en vez de
// cobrar otro producto. Cubre variantes: otras restas, varias restas, mayusculas, acentos y cantidades.
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { resolveOrderItemsAgainstProducts, tokenizeForProductSearch } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));

async function buscar(consulta: string) {
  const world = await mundo;
  return searchProducts(world.repo, { propertyId: world.propertyBySlug.get("garcia-lavin")!, query: consulta });
}
const esPastor = (n: string) => /pastor/i.test(n.normalize("NFD").replace(/\p{Diacritic}/gu, ""));
const ambiguos = (r: Array<{ ambiguo?: boolean }>) => r.every((p) => p.ambiguo === true);

describe("R8: «nachos sin pastor» nunca es Nachos de Pastor", () => {
  const SIN_PASTOR = [
    "nachos sin pastor",
    "NACHOS SIN PASTOR",
    "Nachós sin pástor",
    "nachos SIN Pastór",
    "dos nachos sin pastor",
    "nachos sin pastor y sin queso",
    "nachos sin pastor ni queso",
    "nachos SIN Pastór y sin Cebolla",
  ];
  it.each(SIN_PASTOR)("«%s»: ningun resultado lleva pastor, hay nachos de otra carne y todos van ambiguos", async (q) => {
    const r = await buscar(q);
    expect(r.length).toBeGreaterThan(0);
    expect(r.filter((p) => esPastor(p.name))).toEqual([]);
    expect(r.every((p) => /^nachos/i.test(p.name))).toBe(true);
    expect(ambiguos(r as never)).toBe(true);
  });

  it("«nachos de pastor sin pastor» se contradice: vacio, nunca Nachos de Pastor", async () => {
    expect(await buscar("nachos de pastor sin pastor")).toEqual([]);
  });

  it.each(["nachos de pastor sin cebolla", "NACHOS DE PASTOR SIN CEBOLLA", "Nachós de pástor sin cebolla"])(
    "«%s»: la resta es otro ingrediente, el platillo pedido es Nachos de Pastor con su precio de menu",
    async (q) => {
      const r = await buscar(q);
      expect(r[0]).toMatchObject({ name: "Nachos de Pastor", price: 328 });
      expect(r.every((p) => /pastor/i.test(p.name))).toBe(true);
    },
  );

  it.each(["nachos sin cebolla", "nachos sin queso", "NACHOS SIN QUESO"])("«%s»: sin pastor forzado, el resultado es relajado y va ambiguo", async (q) => {
    const r = await buscar(q);
    expect(r.length).toBeGreaterThan(0);
    expect(ambiguos(r as never)).toBe(true);
  });

  it("«nachos de bistec sin pastor» da solo Nachos de Bistec", async () => {
    const r = await buscar("nachos de bistec sin pastor");
    expect(r.map((p) => p.name)).toEqual(["Nachos de Bistec", "Nachos de Bistec (1/2 orden)"]);
  });

  it("sin la resta, «nachos pastor» sigue siendo Nachos de Pastor sin marca de ambiguo", async () => {
    const r = await buscar("nachos pastor");
    expect(r.map((p) => p.name)).toEqual(["Nachos de Pastor", "Nachos de Pastor (1/2 orden)"]);
    expect(r.some((p) => (p as { ambiguo?: boolean }).ambiguo === true)).toBe(false);
  });

  it("el pedido no inventa producto: «Nachos sin Pastor» como nombre se rechaza, nunca se resuelve a Nachos de Pastor", async () => {
    const catalogo = await buscar("nachos");
    expect(catalogo.some((p) => p.name === "Nachos de Pastor")).toBe(true);
    for (const nombre of ["Nachos sin Pastor", "NACHOS SIN PASTOR", "nachos sin pastor y sin queso"]) {
      expect(() => resolveOrderItemsAgainstProducts([{ productName: nombre }], catalogo), nombre).toThrow(OrderValidationError);
    }
  });
});

// Regresion bloqueante del revisor: la puntuacion pegada a la palabra restada («pastor.») hacia reaparecer Nachos de Pastor.
describe("R8: puntuacion, cortesias y cantidades de varios digitos no rompen «sin X»", () => {
  const BASES = ["nachos sin pastor", "Nachós SIN Pástor", "NACHOS SIN PASTOR"];
  const SUFIJOS = [".", "!", "?", "...", ")", ",", ";", ":", "!!!", "?!", "\"", "'", " .", "/queso", ", por favor", " por favor", ", gracias", " Por Favor!", ", porfa.", "... gracias"];
  const casos = BASES.flatMap((b) => SUFIJOS.map((s) => `${b}${s}`));
  it.each(casos)("«%s»: nunca Nachos de Pastor, siempre nachos de otra carne y ambiguo", async (q) => {
    const r = await buscar(q);
    expect(r.length).toBeGreaterThan(0);
    expect(r.filter((p) => esPastor(p.name))).toEqual([]);
    expect(r.every((p) => /^nachos/i.test(p.name))).toBe(true);
    expect(ambiguos(r as never)).toBe(true);
  });

  it.each(["¿nachos sin pastor?", "(nachos sin pastor)", "¡nachos sin pastor!", "\"nachos sin pastor\"", "nachos, sin pastor", "nachos sin pastor, y sin queso."])(
    "«%s»: puntuacion al inicio o en medio tampoco lo rompe",
    async (q) => {
      const r = await buscar(q);
      expect(r.length).toBeGreaterThan(0);
      expect(r.filter((p) => esPastor(p.name))).toEqual([]);
      expect(ambiguos(r as never)).toBe(true);
    },
  );

  it.each(["frijoles charros sin queso!", "frijoles charros sin queso.", "frijoles charros sin queso, gracias", "Frijoles Charros SIN Quesó?", "frijoles charros sin queso)"])(
    "«%s»: nunca Frijoles Charros con Queso",
    async (q) => {
      const r = await buscar(q);
      expect(r.length).toBeGreaterThan(0);
      expect(r.filter((p) => /con queso/i.test(p.name))).toEqual([]);
      expect(ambiguos(r as never)).toBe(true);
    },
  );

  it.each(["12 nachos sin pastor", "12 nachos sin pastor.", "10 Nachós SIN Pástor, por favor", "25 nachos sin pastor!"])("«%s»: la cantidad de 2 digitos se descarta", async (q) => {
    const r = await buscar(q);
    expect(r.length).toBeGreaterThan(0);
    expect(r.filter((p) => esPastor(p.name))).toEqual([]);
    expect(ambiguos(r as never)).toBe(true);
  });

  it("«12 nachos de pastor» y «10 tacos de pastor» encuentran el platillo (la cantidad no es parte del nombre)", async () => {
    expect((await buscar("12 nachos de pastor"))[0]).toMatchObject({ name: "Nachos de Pastor", price: 328 });
    expect((await buscar("10 tacos de pastor")).length).toBeGreaterThan(0);
  });

  it("la puntuacion tampoco cambia lo que ya funcionaba sin resta: «nachos de pastor.» y «nachos de pastor, por favor»", async () => {
    for (const q of ["nachos de pastor.", "nachos de pastor, por favor", "¿nachos de pastor?"]) {
      const r = await buscar(q);
      expect(r.map((p) => p.name), q).toEqual(["Nachos de Pastor", "Nachos de Pastor (1/2 orden)"]);
    }
  });

  describe("tokenizador: lo que NO debe tocar la limpieza", () => {
    it("fracciones, decimales y pesos siguen igual", () => {
      expect(tokenizeForProductSearch("1/2 nachos")).toContain("1/2");
      expect(tokenizeForProductSearch("media orden de nachos")).toContain("1/2");
      expect(tokenizeForProductSearch("cerveza 0.0")).toContain("0.0");
      expect(tokenizeForProductSearch("pastor 1.5 kg")).toContain("peso:1500");
      expect(tokenizeForProductSearch("pastor 500 g")).toContain("peso:500");
      expect(tokenizeForProductSearch("pastor 1 kilo.")).toContain("peso:1000");
    });
    it("un numero de varios digitos que acompaña a una unidad o al final no se descarta", () => {
      expect(tokenizeForProductSearch("coca 600 ml")).toContain("600");
      expect(tokenizeForProductSearch("600 ml coca")).toContain("600");
      expect(tokenizeForProductSearch("pastor 500")).toContain("500");
      expect(tokenizeForProductSearch("750 de poc chuc")).not.toContain("poc chuc");
    });
    it("la puntuacion queda fuera de los tokens", () => {
      expect(tokenizeForProductSearch("nachos sin pastor...")).toEqual(["nacho", "sin", "pastor"]);
      expect(tokenizeForProductSearch("nachos sin pastor, por favor")).toEqual(["nacho", "sin", "pastor"]);
    });
  });
});
