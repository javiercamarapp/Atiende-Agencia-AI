// PM Ronda 19 (decision del dueño, 23-oct-2026): gringas y mestizas se venden por ORDEN de 2; alambre y tacos suizos por orden de 5.
// Sin LLM, sin red, sin base. El servidor (seed) rechaza lo que no es multiplo, el menu del arnes coincide, y la tabla de unidades de la regla de turno (#638) coincide con ambos.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { bloqueCantidadNoMultiplo, familiaUnidadPm } from "../src/unidades-pm.ts";
import type { ProductoEncontrado } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
const MENU = (JSON.parse(readFileSync(new URL("../src/evals/agente-pm/menu-pm.json", import.meta.url), "utf8")) as { productos: Array<{ nombre: string; pack_size: number }> }).productos;

const exacto = async (nombre: string): Promise<ProductoEncontrado> => {
  const w = await mundo;
  const r = (await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query: nombre, branch_slug: "garcia-lavin" })).result as Array<{ id: string; name: string; price: number; pack_size: number | null }>;
  const h = r.find((p) => p.name === nombre);
  if (!h) throw new Error(`no esta en el catalogo: ${nombre}`);
  return { id: h.id, name: h.name, price: h.price, packSize: h.pack_size, requiresAdultConfirmation: false };
};

describe("cotizar_pedido con el seed: gringas, mestizas, alambre y suizos van por orden", () => {
  it.each([
    ["Gringa de Pastor", 2],
    ["Mestiza de Bistec", 2],
    ["Alambre de Pastor", 5],
    ["Suizo de Bistec", 5],
    ["Alambre Suizo de Pastor", 5],
  ] as const)("%s: pack_size %i; una pieza de menos o de mas se rechaza con las opciones validas y la orden completa cuesta el precio de menu", async (nombre, pack) => {
    const p = await exacto(nombre);
    expect(p.packSize).toBe(pack);
    expect(() => buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: pack + 1, tortilla: "maiz" }], [p])).toThrow(new RegExp(`órdenes de ${pack} piezas`));
    expect(() => buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: 1, tortilla: "maiz" }], [p])).toThrow(new RegExp(`puedes pedir ${pack}`));
    expect(buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: pack, tortilla: "maiz" }], [p]).total).toBe(p.price);
    expect(buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: pack * 2, tortilla: "maiz" }], [p]).total).toBe(p.price * 2);
  });

  it("«3 gringas» se rechaza y ofrece 2 o 4 piezas", async () => {
    const p = await exacto("Gringa de Pastor");
    expect(() => buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: 3, tortilla: "harina" }], [p])).toThrow(/Pediste 3; puedes pedir 2 o 4/);
  });
});

describe("coherencia entre el menu del arnes, el seed y la regla de turno de #638", () => {
  it("el pack del menu del arnes es el de la tabla de unidades en gringas, mestizas, alambre y suizos", () => {
    const familias = MENU.filter((p) => /^(Gringa|Mestiza|Alambre de|Suizo de|Alambre Suizo|Tacos Suizos)/.test(p.nombre));
    expect(familias.length).toBe(7 + 7 + 6 + 9 + 6 + 2);
    for (const p of familias) expect(familiaUnidadPm(p.nombre)?.piezasPorOrden, p.nombre).toBe(p.pack_size);
  });

  it("el bloque de turno ofrece las mismas opciones que la herramienta: 3 gringas -> 2 o 4", () => {
    const g = bloqueCantidadNoMultiplo(["quiero 3 gringas de pastor"]);
    expect(g).toMatch(/2 piezas \(1 orden\) o 4 piezas \(2 ordenes\)/);
    expect(g).toMatch(/otro pack_size.*manda la herramienta/);
  });
});
