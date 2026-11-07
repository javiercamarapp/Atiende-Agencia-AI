// Cerebro v2: searchProducts con la bandera ordena el catalogo de la sucursal con la busqueda del suelto; sin bandera, la de siempre.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import type { RestaurantesRepository } from "../src/repository.ts";

const prod = (name: string, categoryName: string, price: number) => ({ id: randomUUID(), name, description: null, categoryName, searchKeywords: [] as string[], price, available: true });
const CATALOGO = [prod("Heineken 0.0", "Cervezas", 55), prod("Heineken", "Cervezas", 50), prod("Sprite Zero", "Refrescos", 35), prod("Sprite", "Refrescos", 35), prod("Tacos de Pastor (orden de 3)", "Tacos", 90)];
const repo = { listAvailableProductsForBranch: async () => CATALOGO } as unknown as RestaurantesRepository;

describe("searchProducts con cerebro v2", () => {
  it("«heineken 00» encuentra la 0.0 primero con la bandera", async () => {
    const r = await searchProducts(repo, { propertyId: "p", query: "heineken 00", cerebroV2: true });
    expect(r[0]?.name).toBe("Heineken 0.0");
  });
  it("«sprite cero cero» encuentra la Zero con la bandera", async () => {
    const r = await searchProducts(repo, { propertyId: "p", query: "sprite cero cero", cerebroV2: true });
    expect(r[0]?.name).toBe("Sprite Zero");
  });
  it("sin bandera no cambia el camino de siempre (mismo resultado que antes)", async () => {
    const r = await searchProducts(repo, { propertyId: "p", query: "tacos de pastor" });
    expect(r.map((p) => p.name)).toContain("Tacos de Pastor (orden de 3)");
  });
});
