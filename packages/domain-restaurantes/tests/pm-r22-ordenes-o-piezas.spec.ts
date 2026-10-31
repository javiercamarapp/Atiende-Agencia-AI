// PM R22 (T7-074): «2 mestizas» (sin «orden(es)» ni «pieza(s)») no se cotiza como «2 órdenes (4 piezas)»: el servidor obliga a preguntar. Datos 100 % sintéticos.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ordenesInterpretadasSinPreguntar } from "../src/unidades-pm.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);
beforeEach(() => prepararEntorno(true));

describe("ordenesInterpretadasSinPreguntar (pura)", () => {
  it.each([
    ["2 mestizas de pastor", "Mestiza", 2, 4, 2],
    ["quiero dos gringas", "Gringa de Pastor", 2, 4, 2],
    ["3 alambres de bistec", "Alambre de Bistec", 5, 15, 3],
  ])("«%s» cotizado como órdenes -> pregunta", (msg, nombre, p, piezas, n) => {
    expect(ordenesInterpretadasSinPreguntar(msg, nombre, p, piezas)).toBe(n);
  });
  it.each([
    ["2 órdenes de mestizas", "Mestiza", 2, 4],
    ["dos ordenes de mestiza", "Mestiza", 2, 4],
    ["4 piezas de mestiza", "Mestiza", 2, 4],
    ["4 mestizas", "Mestiza", 2, 4],
    ["2 mestizas", "Mestiza", 2, 2],
    ["2 mestizas", "Mestiza", null, 4],
    ["2 kilos de pastor", "Pastor (kilo)", 2, 4],
    ["efectivo", "Mestiza", 2, 4],
  ])("«%s» no interviene", (msg, nombre, p, piezas) => {
    expect(ordenesInterpretadasSinPreguntar(msg, nombre, p, piezas)).toBeNull();
  });
});

describe("cotizar_pedido: órdenes o piezas (T7-074)", () => {
  async function conMestizas() {
    const s = setup();
    const id = randomUUID();
    s.f.repo.seedProduct({ id, organizationId: s.f.organizationId, categoryId: s.f.categories.tacos, name: "Mestiza", description: "Orden de 2 piezas", searchKeywords: [] });
    s.f.repo.seedBranchProduct({ propertyId: s.f.propertyId, productId: id, price: 168, isAvailable: true });
    return { s, id };
  }
  const item = (id: string, q: number) => [{ product_id: id, product_name: "Mestiza", requested_quantity: q }];

  it("«2 mestizas» cotizado como 4 piezas (2 órdenes) se rechaza con la pregunta", async () => {
    const { s, id } = await conMestizas();
    s.cliente("2 mestizas de pastor, de harina");
    await expect(s.quote({ items: item(id, 4) })).rejects.toThrow(/¿2 órdenes \(4 piezas\) o 2 piezas\?/);
  });
  it("no regresión: «2 órdenes de mestizas» explícito sí cotiza 2 órdenes (4 piezas)", async () => {
    const { s, id } = await conMestizas();
    s.cliente("2 órdenes de mestizas de pastor");
    await s.quote({ items: item(id, 4), payment_method: "tarjeta", efectivo_con: undefined });
    expect(await s.canonico()).toContain("2 órdenes (4 piezas) de Mestiza");
  });
  it("tras preguntar, «2 piezas» o «2 órdenes» cotizan", async () => {
    const { s, id } = await conMestizas();
    s.cliente("2 mestizas");
    s.asistente("¿2 órdenes (4 piezas) o 2 piezas?");
    s.cliente("2 órdenes");
    await s.quote({ items: item(id, 4), payment_method: "tarjeta", efectivo_con: undefined });
    expect(await s.canonico()).toContain("2 órdenes (4 piezas) de Mestiza");
  });
});
