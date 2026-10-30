// PM R22 (causa 4 / R4): el resumen y la comanda decian «1 × Gringa» sin decir que una orden son 2 piezas (SIM 174, 175, 258; T7-012, T7-074). La fuente es `packSize` del catalogo.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { etiquetaOrdenConPiezas } from "../src/order-quote.ts";
import { piezasPorOrdenDe } from "../src/unidades-pm.ts";
import { resumenCanonico } from "../src/agent-tools/cierre-maquina.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("R22: piezas visibles", () => {
  it("etiqueta: singular, plural y sin dato (no inventa piezas)", () => {
    expect(etiquetaOrdenConPiezas(1, 2)).toBe("1 orden (2 piezas)");
    expect(etiquetaOrdenConPiezas(2, 2)).toBe("2 órdenes (4 piezas)");
    expect(etiquetaOrdenConPiezas(1, 5)).toBe("1 orden (5 piezas)");
    expect(etiquetaOrdenConPiezas(2, null)).toBeNull();
    expect(etiquetaOrdenConPiezas(2, 1)).toBeNull();
    expect(etiquetaOrdenConPiezas(2, undefined)).toBeNull();
  });

  it("resumenCanonico: con piezas por orden las muestra; sin dato queda «N × nombre»", () => {
    const c = resumenCanonico({
      lineas: [
        { name: "Gringa de Pastor", quantity: 1, piezasPorOrden: 2, lineTotal: 194 },
        { name: "Mestiza", quantity: 2, piezasPorOrden: 2, lineTotal: 336 },
        { name: "Coca-Cola", quantity: 2, lineTotal: 90 },
      ],
      total: 620,
      canal: "recoger",
      datos: { pago: "tarjeta" },
    });
    expect(c).toContain("• 1 orden (2 piezas) de Gringa de Pastor — $194");
    expect(c).toContain("• 2 órdenes (4 piezas) de Mestiza — $336");
    expect(c).toContain("• 2 × Coca-Cola — $90");
  });

  it("un nombre que ya dice «(orden de 3)» no repite las piezas", () => {
    const c = resumenCanonico({ lineas: [{ name: "Tacos de Bistec de Res (orden de 3)", quantity: 1, piezasPorOrden: 3, lineTotal: 99 }], total: 99, canal: "recoger", datos: { pago: "tarjeta" } });
    expect(c).toContain("• 1 × Tacos de Bistec de Res (orden de 3) — $99");
  });

  async function conGringas() {
    const s = setup();
    const f = s.f;
    const id = randomUUID();
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Gringa de Pastor", description: null, searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price: 194, isAvailable: true });
    return { s, id };
  }

  it("sin pack_size en el menú no se etiqueta (la cantidad puede ser piezas: «4 gringas» no es «4 órdenes (8 piezas)»)", async () => {
    const { s, id } = await conGringas();
    await s.quote({ payment_method: "tarjeta", efectivo_con: undefined, items: [{ product_id: id, product_name: "Gringa de Pastor", requested_quantity: 4 }] });
    const c = await s.canonico();
    expect(c).toContain("• 4 × Gringa de Pastor");
    expect(c).not.toMatch(/piezas/);
  });

  it.each(["Mestiza (media orden)", "Tacos de Chorizo (1/2 orden)", "Combo alitas + chela", "Salsa para alitas", "Gringa de Pastor kilo", "Extra de gringa"])("«%s» con pack_size no se etiqueta como orden entera", (nombre) => {
    expect(piezasPorOrdenDe(nombre, 2)).toBeNull();
  });
  it("con pack_size y nombre de orden entera sí", () => {
    expect(piezasPorOrdenDe("Gringa de Pastor", 2)).toBe(2);
    expect(piezasPorOrdenDe("Gringa de Pastor", null)).toBeNull();
    expect(piezasPorOrdenDe("Gringa de Pastor", 1)).toBeNull();
  });

  it("con pack_size del catálogo (descripción «orden de 2»): 4 piezas = 2 órdenes (4 piezas)", async () => {
    const s = setup();
    const f = s.f;
    const id = randomUUID();
    f.repo.seedProduct({ id, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Gringa de Pastor", description: "Orden de 2 piezas", searchKeywords: [] });
    f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: id, price: 194, isAvailable: true });
    await s.quote({ payment_method: "tarjeta", efectivo_con: undefined, items: [{ product_id: id, product_name: "Gringa de Pastor", requested_quantity: 4 }] });
    expect(await s.canonico()).toContain("• 2 órdenes (4 piezas) de Gringa de Pastor — $388");
  });

  it("la comanda (notas del pedido) dice cuántas piezas son; un producto sin dato no lleva línea", async () => {
    const s = setup();
    const id = randomUUID();
    s.f.repo.seedProduct({ id, organizationId: s.f.organizationId, categoryId: s.f.categories.tacos, name: "Gringa de Pastor", description: "Orden de 2 piezas", searchKeywords: [] });
    s.f.repo.seedBranchProduct({ propertyId: s.f.propertyId, productId: id, price: 194, isAvailable: true });
    const f = s.f;
    const order = await createOrder(f.repo, {
      organizationId: f.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Cliente Sintético",
      customerPhone: "9991234567",
      items: [{ productId: id, requestedQuantity: 4 }, { productId: f.products.cocaCola, requestedQuantity: 2 }],
      source: "whatsapp",
      paymentMethod: "tarjeta",
      canal: "recoger",
    });
    expect(order.notes).toContain("Gringa de Pastor: 2 órdenes (4 piezas).");
    expect(order.notes).not.toContain("Coca-Cola:");
  });
});
