// QA-PM-R4-reglas-03 (VRG09): "un cuarto de bistec y tres cuartos de chuleta" llegaba a la herramienta como requested_quantity 250 y 750 sobre el producto de 1 kg.
import { describe, expect, it } from "vitest";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import type { ProductoEncontrado } from "../src/types.ts";

const bistecKg: ProductoEncontrado = { id: "b1", name: "Bistec de Res — 1 kg", price: 1100, packSize: null, requiresAdultConfirmation: false };
const bistec250: ProductoEncontrado = { id: "b250", name: "Bistec de Res — 250 g", price: 275, packSize: null, requiresAdultConfirmation: false };

describe("producto por peso con gramos como cantidad", () => {
  it("requested_quantity 250 sobre el producto de 1 kg se rechaza diciendo que use la presentacion de 250 g", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "b1", requestedQuantity: 250 }], [bistecKg])).toThrow(/se vende por peso.*"cuarto de bistec".*requested_quantity 1/s);
  });
  it("750 (sobre el maximo) tambien explica que son gramos", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "b1", requestedQuantity: 750 }], [bistecKg])).toThrow(/GRAMOS/);
  });
  it("30 piezas del producto de 1 kg (30 kg) es un pedido grande legitimo: se cotiza, no se rechaza como gramos", () => {
    expect(buildOrderQuoteFromProducts([{ productId: "b1", requestedQuantity: 30 }], [bistecKg], { canal: "recoger" }).total).toBe(33000);
  });
  it("la presentacion exacta de 250 g con cantidad 1 cotiza bien; 2 kilos como 2 piezas del de 1 kg tambien", () => {
    expect(buildOrderQuoteFromProducts([{ productId: "b250", requestedQuantity: 1 }], [bistec250], { canal: "recoger" }).total).toBe(275);
    expect(buildOrderQuoteFromProducts([{ productId: "b1", requestedQuantity: 2 }], [bistecKg], { canal: "recoger" }).total).toBe(2200);
  });
});
