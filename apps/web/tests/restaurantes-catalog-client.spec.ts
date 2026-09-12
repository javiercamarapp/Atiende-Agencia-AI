import { describe, expect, it, vi } from "vitest";
import { createCategory, createProduct, fetchCategories, fetchProducts, setBranchAvailability, updateProduct } from "../src/verticals/restaurantes/lib/catalog-client.ts";

describe("fetchCategories / createCategory", () => {
  it("lista categorías reales", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/categories");
      return new Response(JSON.stringify({ categories: [{ id: "cat-1", name: "Tacos", slug: "tacos", displayOrder: 0 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCategories(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([{ id: "cat-1", name: "Tacos", slug: "tacos", displayOrder: 0 }]);
  });

  it("crea una categoría real (POST)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ name: "Postres", slug: "postres" });
      return new Response(JSON.stringify({ category: { id: "cat-2", name: "Postres", slug: "postres", displayOrder: 0 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createCategory(fetchImpl, "http://api.local", "tok", "prop-1", { name: "Postres", slug: "postres" });
    expect(result.id).toBe("cat-2");
  });
});

const PRODUCT_ROW = {
  id: "prod-1",
  categoryId: "cat-1",
  categoryName: "Tacos",
  name: "Tacos al pastor",
  description: null,
  price: 100,
  imageUrl: null,
  isPopular: false,
  isAvailable: true,
  displayOrder: 0,
  searchKeywords: [],
  branch: { propertyId: "prop-1", productId: "prod-1", price: 110, isAvailable: true },
};

describe("fetchProducts / createProduct / updateProduct / setBranchAvailability", () => {
  it("lista productos con el estado de ESTA sucursal", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ products: [PRODUCT_ROW] }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchProducts(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result[0]?.branch).toEqual({ propertyId: "prop-1", productId: "prod-1", price: 110, isAvailable: true });
  });

  it("crea un producto nuevo -- branch null hasta activarlo", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ product: { ...PRODUCT_ROW, branch: null } }), { status: 201 })) as unknown as typeof fetch;
    const result = await createProduct(fetchImpl, "http://api.local", "tok", "prop-1", { name: "Flan", price: 50 });
    expect(result.branch).toBeNull();
  });

  it("edita nombre/precio de un producto", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/products/prod-1");
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ product: { ...PRODUCT_ROW, name: "Nuevo nombre" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateProduct(fetchImpl, "http://api.local", "tok", "prop-1", "prod-1", { name: "Nuevo nombre" });
    expect(result.name).toBe("Nuevo nombre");
  });

  it("activa/edita precio en esta sucursal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/products/prod-1/branch-availability");
      return new Response(JSON.stringify({ branch: { propertyId: "prop-1", productId: "prod-1", price: 120, isAvailable: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await setBranchAvailability(fetchImpl, "http://api.local", "tok", "prop-1", "prod-1", { price: 120, isAvailable: true });
    expect(result.price).toBe(120);
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Producto no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(updateProduct(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe", { name: "x" })).rejects.toThrow("Producto no encontrado.");
  });
});
