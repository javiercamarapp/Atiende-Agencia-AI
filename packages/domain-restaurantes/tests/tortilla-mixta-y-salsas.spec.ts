// PM PR-3 (a): tortilla "mixta" y las 9 salsas incluidas sin costo; la doble porcion es un extra
// COBRADO con precio de catalogo (nunca inventado).
import { describe, expect, it } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { buildComplementNotes, buildDoubleSalsaLine, buildOrderQuoteFromProducts, DEFAULT_COMPLEMENTS, isTortillaChoice } from "../src/order-quote.ts";
import { validateCreateOrderPayload } from "../src/orders.ts";
import { fingerprintOrder } from "../src/agent-tools/order-flow.ts";
import type { CreateOrderInput, ProductoEncontrado } from "../src/types.ts";

const pastor: ProductoEncontrado = { id: "pastor", name: "Tacos al Pastor", price: 28, packSize: 1, requiresAdultConfirmation: false };
const bistec: ProductoEncontrado = { id: "bistec", name: "Tacos de Bistec de Res (orden de 3)", price: 164, packSize: 3, requiresAdultConfirmation: false };
const extraSalsa: ProductoEncontrado = { id: "extra-salsa", name: "Extra salsa", price: 12.5, packSize: null, requiresAdultConfirmation: false };

describe("tortilla mixta", () => {
  it("se acepta en la cotizacion, sin recargo, y viaja en el renglon", () => {
    const quote = buildOrderQuoteFromProducts([{ productId: "pastor", requestedQuantity: 4, tortilla: "mixta" }], [pastor]);
    expect(quote.lines[0]!.tortilla).toBe("mixta");
    expect(quote.total).toBe(112);
  });

  it("una tortilla fuera del catalogo se rechaza nombrando las tres opciones", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "pastor", requestedQuantity: 1, tortilla: "integral" as never }], [pastor])).toThrow(/maíz, harina o mixta/);
    expect(isTortillaChoice("mixta")).toBe(true);
    expect(isTortillaChoice("integral")).toBe(false);
  });

  it("la regla 'tacos de bistec solo en ordenes de 3' sigue intacta con tortilla mixta", () => {
    expect(() => buildOrderQuoteFromProducts([{ productId: "bistec", requestedQuantity: 4, tortilla: "mixta" }], [bistec])).toThrow(/orden de 3/);
    const quote = buildOrderQuoteFromProducts([{ productId: "bistec", requestedQuantity: 6, tortilla: "mixta" }], [bistec]);
    expect(quote.lines[0]!.quantity).toBe(2);
    expect(quote.total).toBe(328);
  });

  it("el payload de crear pedido la acepta y rechaza una invalida", () => {
    const base = { organizationId: "o", branchSlug: "t1", customerName: "Ana", customerPhone: "9991234567", source: "web" } as const;
    expect(() => validateCreateOrderPayload({ ...base, items: [{ productId: "11111111-1111-4111-8111-111111111111", requestedQuantity: 3, tortilla: "mixta" }] } as CreateOrderInput)).not.toThrow();
    expect(() => validateCreateOrderPayload({ ...base, items: [{ productId: "11111111-1111-4111-8111-111111111111", requestedQuantity: 3, tortilla: "otra" as never }] } as CreateOrderInput)).toThrow(OrderValidationError);
  });
});

describe("las 9 salsas incluidas", () => {
  it("son exactamente las 9 del dueno", () => {
    expect([...DEFAULT_COMPLEMENTS].sort()).toEqual(
      ["cebolla_cilantro", "crema_ajo", "limones", "salsa_guacamolera", "salsa_habanero", "salsa_mexicana", "salsa_pina", "salsa_roja", "salsa_verde"].sort(),
    );
  });

  it("omitir 'cebolla' (nombre historico) quita la cebolla con cilantro y solo esa", () => {
    const notes = buildComplementNotes(undefined, [], ["cebolla"]);
    expect(notes).not.toMatch(/cebolla/);
    expect(notes).toMatch(/salsa guacamolera/);
  });
});

describe("doble porcion de salsa (extra cobrado)", () => {
  it("cobra una pieza de 'Extra salsa' por salsa en doble, al precio del catalogo", () => {
    const line = buildDoubleSalsaLine([pastor, extraSalsa], ["salsa_roja", "salsa_verde", "salsa_roja"])!;
    expect(line.productId).toBe("extra-salsa");
    expect(line.quantity).toBe(2);
    expect(line.lineTotal).toBe(25);
    expect(line.name).toMatch(/salsa roja, salsa verde/);
  });

  it("sin doble porcion no agrega renglon", () => {
    expect(buildDoubleSalsaLine([pastor, extraSalsa], [])).toBeNull();
  });

  it("sin el producto en catalogo NO inventa precio: rechaza con mensaje accionable", () => {
    expect(() => buildDoubleSalsaLine([pastor], ["salsa_roja"])).toThrow(/todavía no tiene precio/);
  });

  it("el payload rechaza una doble porcion de algo que no es salsa incluida", () => {
    const base = { organizationId: "o", branchSlug: "t1", customerName: "Ana", customerPhone: "9991234567", source: "web", items: [{ productId: "11111111-1111-4111-8111-111111111111", requestedQuantity: 1 }] } as const;
    expect(() => validateCreateOrderPayload({ ...base, doubleSalsas: ["salsa_roja"] } as CreateOrderInput)).not.toThrow();
    expect(() => validateCreateOrderPayload({ ...base, doubleSalsas: ["queso"] as never } as CreateOrderInput)).toThrow(/solo aplica a las salsas/);
  });

  it("la huella de la cotizacion cambia con la doble porcion, y no cambia sin ella", () => {
    const items = [{ productId: "pastor", requestedQuantity: 2 }];
    const sin = fingerprintOrder({ branchSlug: "t1", items });
    expect(fingerprintOrder({ branchSlug: "t1", items, doubleSalsas: [] })).toBe(sin);
    expect(fingerprintOrder({ branchSlug: "t1", items, doubleSalsas: ["salsa_roja"] })).not.toBe(sin);
  });
});
