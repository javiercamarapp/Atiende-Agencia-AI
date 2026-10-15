// Caso grave R8: «nachos sin pastor» es nachos SIN el ingrediente pastor. Prueba determinista (sin LLM, menu sembrado en memoria): la busqueda nunca devuelve
// «Nachos de Pastor» cuando el pastor se resta, siempre marca `ambiguo` (el agente debe confirmar la suposicion) y el pedido rechaza un nombre inventado en vez de
// cobrar otro producto. Cubre variantes: otras restas, varias restas, mayusculas, acentos y cantidades.
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { resolveOrderItemsAgainstProducts } from "../src/product-search.ts";
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
