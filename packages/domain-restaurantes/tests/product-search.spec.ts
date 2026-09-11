import { describe, expect, it } from "vitest";
import { extraerPackSize, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, tokenizeForProductSearch } from "../src/product-search.ts";
import { OrderValidationError } from "../src/errors.ts";
import { searchProducts } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("tokenizeForProductSearch", () => {
  it("encuentra 'pizza' aunque solo viva en description/search_keywords (bug real 4-sep-2026)", async () => {
    const { repo, propertyId } = buildRestaurantFixture();
    const results = await searchProducts(repo, { propertyId, query: "quiero una pizza" });
    expect(results.map((r) => r.name)).toContain("Quesobich de Queso");
  });

  it("'cerveza Sol' encuentra 'Sol' (categoría de bebida no debe bloquear el match)", async () => {
    const { repo, propertyId } = buildRestaurantFixture();
    const results = await searchProducts(repo, { propertyId, query: "una cerveza Sol" });
    expect(results.map((r) => r.name)).toContain("Sol");
  });

  it("singulariza plurales simples ('tacos' encuentra 'Tacos de Bistec...')", () => {
    const tokens = tokenizeForProductSearch("quiero tacos de bistec");
    expect(tokens).toContain("taco");
  });

  it("normaliza pesos pegados y frases de kilos ('medio kilo' -> 500g -> ['500','g'])", () => {
    expect(tokenizeForProductSearch("medio kilo de arrachera")).toEqual(expect.arrayContaining(["500", "g", "arrachera"]));
    expect(tokenizeForProductSearch("1kg de bistec")).toEqual(expect.arrayContaining(["1", "kg", "bistec"]));
  });
});

describe("extraerPackSize", () => {
  it("extrae el tamaño de 'orden de N'", () => {
    expect(extraerPackSize("Tacos de Bistec de Res (orden de 3)", null)).toBe(3);
  });
  it("detecta 'individual' como pack_size 1", () => {
    expect(extraerPackSize("Taco Al Pastor (individual)", null)).toBe(1);
  });
  it("null cuando no aplica la noción de piezas por paquete", () => {
    expect(extraerPackSize("Coca-Cola", null)).toBeNull();
  });
});

describe("requiresAdultConfirmation", () => {
  it("true para categoría Cervezas/Licores y Cocktails", () => {
    expect(requiresAdultConfirmation("Sol", "Cervezas")).toBe(true);
    expect(requiresAdultConfirmation("Margarita", "Licores y Cocktails")).toBe(true);
  });
  it("false para 'sin alcohol' o '0.0' aunque la categoría sea de alcohol", () => {
    expect(requiresAdultConfirmation("Margarita sin alcohol", "Licores y Cocktails")).toBe(false);
    expect(requiresAdultConfirmation("Cerveza 0.0", "Cervezas")).toBe(false);
  });
  it("false para categorías normales", () => {
    expect(requiresAdultConfirmation("Coca-Cola", "Bebidas")).toBe(false);
  });
});

describe("resolveOrderItemsAgainstProducts — guardia anti-alucinación de precio", () => {
  const products = [{ id: "p1", name: "Tacos de Bistec de Res (orden de 3)", price: 164, packSize: 3, requiresAdultConfirmation: false }];

  it("resuelve por id exacto", () => {
    const [resolved] = resolveOrderItemsAgainstProducts([{ productId: "p1", requestedQuantity: 3 }], products);
    expect(resolved!.productId).toBe("p1");
    expect(resolved!.productName).toBe("Tacos de Bistec de Res (orden de 3)");
  });

  it("resuelve por nombre exacto cuando el id no vino o es inválido", () => {
    const [resolved] = resolveOrderItemsAgainstProducts([{ productName: "Tacos de Bistec de Res (orden de 3)", requestedQuantity: 3 }], products);
    expect(resolved!.productId).toBe("p1");
  });

  it("RECHAZA un producto que no existe en el catálogo en vez de inventar un precio", () => {
    expect(() => resolveOrderItemsAgainstProducts([{ productId: "no-existe", requestedQuantity: 1 }], products)).toThrow(OrderValidationError);
    expect(() => resolveOrderItemsAgainstProducts([{ productName: "Producto Inventado" }], products)).toThrow(OrderValidationError);
  });

  it("RECHAZA cuando el id y el nombre mandados no coinciden entre sí (nunca cambia en silencio qué se cobra)", () => {
    expect(() => resolveOrderItemsAgainstProducts([{ productId: "p1", productName: "Otro Producto" }], products)).toThrow(OrderValidationError);
  });
});
