import { describe, expect, it } from "vitest";
import { extraerPackSize, matchesProductSearch, requiresAdultConfirmation, resolveOrderItemsAgainstProducts, tokenizeForProductSearch } from "../src/product-search.ts";
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

  it("normaliza pesos pegados y frases de kilos a un token peso:<gramos> ('medio kilo' -> peso:500)", () => {
    expect(tokenizeForProductSearch("medio kilo de arrachera")).toEqual(expect.arrayContaining(["peso:500", "arrachera"]));
    expect(tokenizeForProductSearch("1kg de bistec")).toEqual(expect.arrayContaining(["peso:1000", "bistec"]));
  });

  it.each([
    ["1/4 de bistec", 250],
    ["un cuarto de bistec", 250],
    ["cuarto de kilo de pastor", 250],
    [".25 kg de pastor", 250],
    ["medio kilo de pastor", 500],
    ["1/2 kg de pastor", 500],
    ["0.5 kg de pastor", 500],
    ["3/4 de bistec", 750],
    ["tres cuartos de kilo de bistec", 750],
    ["pastor .750", 750],
    ["kilo y medio de pastor", 1500],
    ["1.5 kg de pastor", 1500],
    ["2 kg de pastor", 2000],
    ["dos kilos de pastor", 2000],
    ["un kilo de pastor", 1000],
    ["1 kg de pastor", 1000],
    ["500g de arrachera", 500],
    ["250 gramos de arrachera", 250],
  ])("el peso de %j es peso:%i", (consulta, gramos) => {
    const tokens = tokenizeForProductSearch(consulta);
    expect(tokens.filter((t) => t.startsWith("peso:"))).toEqual([`peso:${gramos}`]);
  });

  it("'1/2' sin unidad NO es peso: sigue siendo la media orden", () => {
    expect(tokenizeForProductSearch("media orden de nachos")).toContain("1/2");
    expect(tokenizeForProductSearch("media orden de nachos").some((t) => t.startsWith("peso:"))).toBe(false);
  });
});

describe("fracciones de kilo: coincidencia EXACTA por peso", () => {
  const productos = [250, 500, 750, 1000, 1500, 2000].map((g) => ({
    name: `Pastor — ${g >= 1000 ? `${g / 1000} kg` : `${g} g`}`,
    description: null,
    categoryName: "Kilos a Domicilio",
    searchKeywords: [] as string[],
  }));
  const buscar = (consulta: string) => productos.filter((p) => matchesProductSearch(tokenizeForProductSearch(consulta), p)).map((p) => p.name);

  it("cada peso encuentra solo su presentacion ('1 kg' no trae '1.5 kg' ni '1/4')", () => {
    expect(buscar("1 kg de pastor")).toEqual(["Pastor — 1 kg"]);
    expect(buscar("kilo y medio de pastor")).toEqual(["Pastor — 1.5 kg"]);
    expect(buscar("2 kg de pastor")).toEqual(["Pastor — 2 kg"]);
    expect(buscar("medio kilo de pastor")).toEqual(["Pastor — 500 g"]);
    expect(buscar("1/4 de pastor")).toEqual(["Pastor — 250 g"]);
    expect(buscar("3/4 de pastor")).toEqual(["Pastor — 750 g"]);
  });

  it("sin peso en la consulta devuelve todas las presentaciones para que el cliente elija", () => {
    expect(buscar("pastor")).toHaveLength(6);
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
