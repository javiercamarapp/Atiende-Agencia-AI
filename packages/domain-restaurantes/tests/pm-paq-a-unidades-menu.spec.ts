// PAQUETE A (PM): unidades confirmadas por Javier (21-oct-2026) en el aviso de unidad de buscar_producto y precios de flauta del seed.
// Pruebas deterministas, sin LLM. Alitas 7, crujientes ~12 (aproximado), pizza Quesobich = 1 pieza sin tortilla ni totopos.
import { describe, expect, it } from "vitest";
import { unidadDeVenta, unidadDeVentaSinPiezas, unidadDeVentaPizza } from "../src/product-search.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import menuEvals from "../src/evals/agente-pm/menu-pm.json" with { type: "json" };

describe("aviso de unidad: alitas y crujientes con el dato confirmado", () => {
  it("alitas sin pack_size: la orden trae 7 piezas y requested_quantity cuenta órdenes", () => {
    const t = unidadDeVentaSinPiezas({ name: "Alitas de Pollo", packSize: null });
    expect(t).toMatch(/7 piezas/);
    expect(t).toMatch(/ÓRDENES/);
    expect(t).not.toMatch(/no registra/i);
  });
  it("crujientes de pechuga: aproximadamente 12, nunca como cifra exacta", () => {
    const t = unidadDeVentaSinPiezas({ name: "Crujientes de Pechuga de Pollo", packSize: null });
    expect(t).toMatch(/aproximadamente 12/i);
    expect(t).toMatch(/ÓRDENES/);
  });
  it("con pack_size explícito manda la herramienta y el aviso desaparece", () => {
    expect(unidadDeVentaSinPiezas({ name: "Alitas de Pollo (orden de 7)", packSize: 7 })).toBeNull();
  });
});

describe("aviso de unidad: pizza Quesobich", () => {
  it("es una pieza, sin tortilla ni totopos, solo salsa y cebolla", () => {
    const t = unidadDeVentaPizza({ name: "Quesobich de Pastor", categoryName: "Pizza Quesobich", packSize: null });
    expect(t).toMatch(/UNA pieza/i);
    expect(t).toMatch(/sin tortilla/i);
    expect(t).toMatch(/totopos/i);
    expect(t).toMatch(/salsa y cebolla/i);
  });
  it("no aplica a otros productos", () => {
    expect(unidadDeVentaPizza({ name: "Gringa de Pastor", packSize: 2 })).toBeNull();
  });
  it("unidadDeVenta lo encadena", () => {
    expect(unidadDeVenta({ name: "Quesobich de Queso", categoryName: "Pizza Quesobich", packSize: null })).toMatch(/UNA pieza/i);
  });
});

describe("precios de flauta confirmados por Javier (21-oct)", () => {
  const { data } = loadSeedInputs();
  const precio = (n: string) => (data.productos.find((p) => p.nombre === n) as unknown as { precios_por_sucursal: Record<string, number> }).precios_por_sucursal;
  it("seed: pastor $276 y arrachera $363 en todas las listas con flautas", () => {
    for (const v of Object.values(precio("Flauta de Pastor"))) expect(v).toBe(276);
    for (const v of Object.values(precio("Flauta de Arrachera"))) expect(v).toBe(363);
  });
  it("menú del arnés: igual", () => {
    const f = (n: string) => menuEvals.productos.find((p) => p.nombre === n)!;
    expect(f("Flauta de Pastor").precio_mxn).toBe(276);
    expect(f("Flauta de Arrachera").precio_mxn).toBe(363);
  });
});
