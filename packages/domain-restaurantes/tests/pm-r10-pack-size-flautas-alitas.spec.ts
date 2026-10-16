// R10 T7-031: «4 flautas, una orden» se cotizaba como 4 órdenes ($2,682 en vez de $1,833) porque buscar_producto devolvía pack_size null y el modelo no sabía
// la unidad. Pruebas deterministas (sin LLM) del mapeo de cantidad y del aviso de unidad. El número de piezas por orden de flautas/alitas/crujientes NO está
// confirmado en el repo (pendiente de PM), así que el seed real sigue sin pack_size; el mapeo se prueba con presentaciones SINTÉTICAS marcadas como tales.
import { describe, expect, it } from "vitest";
import { invokeAgentTool, quoteToWire } from "../src/agent-tools/registry.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { extraerPackSize, unidadDeVentaSinPiezas } from "../src/product-search.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import type { ProductoEncontrado } from "../src/types.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const mundo = buildInMemoryPmWorld(buildPmSeedPlan(data, agent));
const buscar = async (query: string) => {
  const w = await mundo;
  const out = await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query, branch_slug: "garcia-lavin" });
  return out.result as Array<{ id: string; name: string; price: number; pack_size: number | null; unidad_de_venta?: string }>;
};

// SINTÉTICO: 4 piezas por orden es solo para ejercitar el mapeo piezas -> órdenes; NO es un dato confirmado de PM.
const flautaSintetica: ProductoEncontrado = { id: "fl", name: "Flauta de Pechuga (orden de 4)", price: 283, packSize: 4, requiresAdultConfirmation: false };
const flautaSinPiezas: ProductoEncontrado = { id: "fl0", name: "Flauta de Pechuga", price: 283, packSize: null, requiresAdultConfirmation: false, categoryName: "Flautas de PM" };

describe("R10 T7-031: mapeo de cantidad de flautas/alitas", () => {
  it("con pack_size N, 4 flautas pedidas son 4 piezas de 1 orden (no 4 órdenes): $283, no $1,132", () => {
    const q = buildOrderQuoteFromProducts([{ productId: "fl", requestedQuantity: 4 }], [flautaSintetica]);
    expect(q.lines[0]!.quantity).toBe(1);
    expect(q.lines[0]!.lineTotal).toBe(283);
    expect(q.total).toBe(283);
  });

  it("el pedido completo de T7-031 con la orden de flautas en 1: $1,100 + $450 + $283 = $1,833", () => {
    const bistec: ProductoEncontrado = { id: "b", name: "Bistec de Res — 1 kg", price: 1100, packSize: null, requiresAdultConfirmation: false };
    const pastor: ProductoEncontrado = { id: "p", name: "Pastor — 500 g", price: 450, packSize: null, requiresAdultConfirmation: false };
    const q = buildOrderQuoteFromProducts(
      [{ productId: "b", requestedQuantity: 1 }, { productId: "p", requestedQuantity: 1 }, { productId: "fl0", requestedQuantity: 1 }],
      [bistec, pastor, flautaSinPiezas],
    );
    expect(q.total).toBe(1833);
  });

  it("sin pack_size la cantidad cuenta ÓRDENES: pedir 4 cobra 4 × $283 = $1,132 (por eso la herramienta ahora explica la unidad)", () => {
    const q = buildOrderQuoteFromProducts([{ productId: "fl0", requestedQuantity: 4 }], [flautaSinPiezas]);
    expect(q.total).toBe(1132);
    expect(quoteToWire(q).lines[0]!.unidad_de_venta).toMatch(/ÓRDENES, no piezas/);
  });

  it("con pack_size N, una cantidad que no es múltiplo se rechaza con las opciones válidas", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "fl", requestedQuantity: 3 }], [flautaSintetica])).toThrow(/orden de 4/);
  });
});

describe("R10 T7-031: la herramienta explica la unidad cuando pack_size es null", () => {
  it("buscar_producto «flauta de pechuga»: pack_size null (no se inventa) y unidad_de_venta por ORDEN", async () => {
    const r = await buscar("flauta de pechuga");
    expect(r.length).toBeGreaterThan(0);
    for (const p of r) {
      expect(p.pack_size).toBeNull();
      expect(p.unidad_de_venta).toMatch(/por ORDEN completa/);
      expect(p.unidad_de_venta).toMatch(/4 flautas, una orden/);
      expect(p.unidad_de_venta).toMatch(/No inventes cuántas piezas/);
    }
  });

  it("alitas y crujientes también llevan el aviso; un taco o una bebida no", async () => {
    for (const q of ["alitas de pollo", "crujientes de pechuga"]) {
      const r = await buscar(q);
      expect(r.length, q).toBeGreaterThan(0);
      expect(r[0]!.pack_size, q).toBeNull();
      expect(r[0]!.unidad_de_venta, q).toMatch(/ORDEN/);
    }
    const tacos = await buscar("tacos de bistec");
    expect(tacos.some((p) => p.pack_size === 3)).toBe(true);
    for (const p of tacos) expect(p.unidad_de_venta).toBeUndefined();
    const coca = await buscar("coca cola");
    for (const p of coca) expect(p.unidad_de_venta).toBeUndefined();
  });

  it("si PM confirma las piezas y se carga «(orden de N)», el aviso desaparece solo y pack_size manda", () => {
    expect(extraerPackSize("Alitas de Pollo (orden de 7)", null)).toBe(7);
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo (orden de 7)", packSize: 7 })).toBeNull();
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo", packSize: null })).not.toBeNull();
  });
});
