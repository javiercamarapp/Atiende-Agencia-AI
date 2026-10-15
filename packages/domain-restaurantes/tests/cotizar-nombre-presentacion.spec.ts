// P5 (ronda 9, VZ02): cotizar_pedido rechazaba «Bistec de Res — 250 g» y el modelo entraba en bucle.
// Se tolera «<nombre> — <presentación>» resolviendo por id, SIN permitir un id con el nombre de OTRO producto.
import { describe, expect, it } from "vitest";
import { resolveOrderItemsAgainstProducts } from "../src/product-search.ts";
import { OrderValidationError } from "../src/errors.ts";
import type { ProductoEncontrado } from "../src/types.ts";

const base = { price: 100, packSize: null, requiresAdultConfirmation: false } as const;
const bistec = { ...base, id: "p-bistec", name: "Bistec de Res" } as unknown as ProductoEncontrado;
const premium = { ...base, id: "p-premium", name: "Bistec de Res Premium" } as unknown as ProductoEncontrado;
const pastor = { ...base, id: "p-pastor", name: "Pastor" } as unknown as ProductoEncontrado;
const cafe = { ...base, id: "p-cafe", name: "Café Americano" } as unknown as ProductoEncontrado;
const catalogo = [bistec, premium, pastor, cafe];

const resolver = (productId: string | undefined, productName: string | undefined) =>
  resolveOrderItemsAgainstProducts([{ productId, productName }], catalogo)[0]!;

describe("resolveOrderItemsAgainstProducts: nombre vs identificador", () => {
  it("coincidencia exacta", () => {
    expect(resolver("p-bistec", "Bistec de Res")).toMatchObject({ productId: "p-bistec", productName: "Bistec de Res" });
  });
  it("con presentación tras « — » o « - » resuelve por id al nombre canónico", () => {
    expect(resolver("p-bistec", "Bistec de Res — 250 g")).toMatchObject({ productId: "p-bistec", productName: "Bistec de Res" });
    expect(resolver("p-bistec", "Bistec de Res - 1 kg")).toMatchObject({ productId: "p-bistec", productName: "Bistec de Res" });
  });
  it("sin nombre, solo id", () => {
    expect(resolver("p-pastor", undefined)).toMatchObject({ productId: "p-pastor", productName: "Pastor" });
  });
  it("id válido con nombre de OTRO producto: rechaza y el error trae el nombre canónico", () => {
    expect(() => resolver("p-bistec", "Pastor")).toThrow(OrderValidationError);
    expect(() => resolver("p-bistec", "Pastor")).toThrow(/«Bistec de Res»/);
    expect(() => resolver("p-bistec", "Pastor — 250 g")).toThrow(OrderValidationError);
  });
  it("nombre que solo COMIENZA igual (otro producto) sigue rechazado", () => {
    expect(() => resolver("p-bistec", "Bistec de Res Premium")).toThrow(OrderValidationError);
    expect(() => resolver("p-bistec", "Bistec de Res Premium — 250 g")).toThrow(OrderValidationError);
    expect(() => resolver("p-bistec", "Bistec de Resx — 250 g")).toThrow(OrderValidationError);
  });
  it("sin separador la presentación no se tolera", () => {
    expect(() => resolver("p-bistec", "Bistec de Res 250 g")).toThrow(OrderValidationError);
  });
  it("id inexistente: rechaza sin nombre válido; con nombre exacto de un producto real se recupera por nombre", () => {
    expect(() => resolver("no-existe", undefined)).toThrow(/Producto no disponible/);
    expect(() => resolver("no-existe", "Inventado")).toThrow(/Producto no disponible/);
    expect(resolver("no-existe", "Pastor")).toMatchObject({ productId: "p-pastor" });
  });
  it("mayúsculas, espacios y normalización Unicode (NFC/NFD) no importan; quitar el acento sí es otro nombre", () => {
    expect(resolver("p-bistec", "  BISTEC   DE RES — 250 G ")).toMatchObject({ productId: "p-bistec" });
    expect(resolver("p-cafe", "café americano")).toMatchObject({ productId: "p-cafe" });
    expect(resolver("p-cafe", "Café Americano — chico")).toMatchObject({ productId: "p-cafe" });
    expect(() => resolver("p-cafe", "Cafe Americano")).toThrow(OrderValidationError);
  });

  it("catálogo real del menú-pm: «Bistec de Res — 250 g» con el id de «— 2 kg» rechaza y nombra ambos", () => {
    const g250 = { ...base, id: "p-250", name: "Bistec de Res — 250 g" } as unknown as ProductoEncontrado;
    const k2 = { ...base, id: "p-2kg", name: "Bistec de Res — 2 kg" } as unknown as ProductoEncontrado;
    const real = [g250, k2];
    let msg = "";
    try {
      resolveOrderItemsAgainstProducts([{ productId: "p-2kg", productName: "Bistec de Res — 250 g" }], real);
    } catch (e) {
      expect(e).toBeInstanceOf(OrderValidationError);
      msg = (e as Error).message;
    }
    expect(msg).toContain("«Bistec de Res — 250 g»");
    expect(msg).toContain("«Bistec de Res — 2 kg»");
    expect(msg).toContain("p-250");
    expect(msg).toContain("MISMO resultado");
    expect(msg).not.toMatch(/no van en el nombre/);
    expect(msg).not.toMatch(/exactamente «Bistec de Res — 2 kg»/);
    // Id y nombre del mismo producto siguen pasando.
    expect(resolveOrderItemsAgainstProducts([{ productId: "p-250", productName: "Bistec de Res — 250 g" }], real)[0]).toMatchObject({ productId: "p-250" });
  });
  it("«Taco» y «Taco - Pastor»: el id de «Taco» con el nombre de «Taco - Pastor» NO se resuelve en silencio", () => {
    const taco = { ...base, id: "a", name: "Taco" } as unknown as ProductoEncontrado;
    const tacoPastor = { ...base, id: "b", name: "Taco - Pastor" } as unknown as ProductoEncontrado;
    const cat = [taco, tacoPastor];
    expect(() => resolveOrderItemsAgainstProducts([{ productId: "a", productName: "Taco - Pastor" }], cat)).toThrow(/id b/);
    expect(resolveOrderItemsAgainstProducts([{ productId: "b", productName: "Taco - Pastor" }], cat)[0]).toMatchObject({ productId: "b" });
    // Sin ser nombre exacto de otro producto, la presentación sigue tolerándose.
    expect(resolveOrderItemsAgainstProducts([{ productId: "a", productName: "Taco - grande" }], cat)[0]).toMatchObject({ productId: "a" });
  });
});
