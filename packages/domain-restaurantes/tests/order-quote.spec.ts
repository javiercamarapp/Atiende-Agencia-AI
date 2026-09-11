import { describe, expect, it } from "vitest";
import { buildComplementNotes, buildOrderQuoteFromProducts, DEFAULT_COMPLEMENTS } from "../src/order-quote.ts";
import { OrderValidationError } from "../src/errors.ts";
import type { ProductoEncontrado } from "../src/types.ts";

const tacos: ProductoEncontrado = { id: "tacos", name: "Tacos de Bistec de Res (orden de 3)", price: 164, packSize: 3, requiresAdultConfirmation: false };
const coca: ProductoEncontrado = { id: "coca", name: "Coca-Cola", price: 45, packSize: null, requiresAdultConfirmation: false };
const cerveza: ProductoEncontrado = { id: "sol", name: "Sol", price: 66, packSize: null, requiresAdultConfirmation: true };

describe("buildOrderQuoteFromProducts", () => {
  it("el precio SIEMPRE sale del catálogo real (product.price), nunca de un total mandado por el cliente", () => {
    const quote = buildOrderQuoteFromProducts([{ productId: "coca", requestedQuantity: 2 }], [coca]);
    expect(quote.total).toBe(90);
    expect(quote.lines[0]!.price).toBe(45);
  });

  it("traduce piezas pedidas a unidades de catálogo cuando pack_size > 1 (8 individuales nunca se vuelve máximo 1)", () => {
    const quote = buildOrderQuoteFromProducts([{ productId: "tacos", requestedQuantity: 3, tortilla: "maiz" }], [tacos]);
    expect(quote.lines[0]!.quantity).toBe(1);
    expect(quote.total).toBe(164);
  });

  it("rechaza una cantidad que no es múltiplo exacto de pack_size, con opciones válidas en el mensaje", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "tacos", requestedQuantity: 4 }], [tacos])).toThrow(/orden de 3/);
  });

  it("exige tortilla para productos cuyo nombre matchea /\\btacos?\\b/ y nunca la carga en productos que no la requieren", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "tacos", requestedQuantity: 3 }], [tacos])).toThrow(/maíz o harina/);
    const quote = buildOrderQuoteFromProducts([{ productId: "tacos", requestedQuantity: 3, tortilla: "maiz" }], [tacos]);
    expect(quote.lines[0]!.tortilla).toBe("maiz");
    const cocaQuote = buildOrderQuoteFromProducts([{ productId: "coca", requestedQuantity: 1, tortilla: "maiz" }], [coca]);
    expect(cocaQuote.lines[0]!.tortilla).toBeNull();
  });

  it("rechaza cotizar alcohol sin adultConfirmed=true explícito", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "sol", requestedQuantity: 1 }], [cerveza])).toThrow(/mayor de edad/);
    const quote = buildOrderQuoteFromProducts([{ productId: "sol", requestedQuantity: 1 }], [cerveza], { adultConfirmed: true });
    expect(quote.containsAlcohol).toBe(true);
    expect(quote.total).toBe(66);
  });

  it("redondea a centavos y acumula el total de varios renglones", () => {
    const quote = buildOrderQuoteFromProducts(
      [
        { productId: "coca", requestedQuantity: 3 },
        { productId: "tacos", requestedQuantity: 6, tortilla: "harina" },
      ],
      [coca, tacos],
    );
    expect(quote.total).toBe(3 * 45 + 2 * 164);
  });
});

describe("buildComplementNotes", () => {
  it("lista los complementos incluidos por default cuando no se omite ninguno", () => {
    const notes = buildComplementNotes(undefined, [], []);
    expect(notes).toBe("Complementos incluidos: salsa verde, salsa roja, limones, cebolla.");
  });
  it("dice explícitamente 'no enviar complementos' cuando se omiten todos", () => {
    const notes = buildComplementNotes(undefined, [], [...DEFAULT_COMPLEMENTS]);
    expect(notes).toMatch(/No enviar complementos de cortesía/);
  });
  it("agrega los complementos solicitados sin duplicar", () => {
    const notes = buildComplementNotes(undefined, ["salsa_habanero", "salsa_habanero"], []);
    expect(notes.match(/salsa habanero/g)).toHaveLength(1);
  });
});
