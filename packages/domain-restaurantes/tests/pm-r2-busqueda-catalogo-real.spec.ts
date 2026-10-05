// QA-PM-R2-reglas-01 (P0): con el catalogo REAL de PM la busqueda debe poner primero el producto correcto en las frases del
// piso del original (cerveza Sol ff76358, plurales y 500g de885b1, T-AM01/04/05/07). Antes el orden era el del catalogo y la
// subcadena "sol" ponia Vodka Absolut antes que la cerveza Sol.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { searchProducts } from "../src/orders.ts";

interface Fila { name: string; description: string | null; category: string | null; keywords: string[] }
const catalogo: Fila[] = JSON.parse(readFileSync(new URL("./fixtures/catalogo-pm-busqueda.json", import.meta.url), "utf8"));

function mundo() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({ propertyId, organizationId, name: "Garcia Lavin", slug: "garcia-lavin", status: "active", phone: null, address: "Merida", lat: 21.0, lng: -89.6 });
  const cats = new Map<string, string>();
  for (const f of catalogo) {
    const nombreCat = f.category ?? "Otros";
    if (!cats.has(nombreCat)) {
      const id = randomUUID();
      repo.seedCategory({ id, organizationId, name: nombreCat });
      cats.set(nombreCat, id);
    }
    const id = randomUUID();
    repo.seedProduct({ id, organizationId, categoryId: cats.get(nombreCat)!, name: f.name, description: f.description, searchKeywords: f.keywords });
    repo.seedBranchProduct({ propertyId, productId: id, price: 100, isAvailable: true });
  }
  return { repo, propertyId };
}
const w = mundo();
const primero = async (query: string) => (await searchProducts(w.repo, { propertyId: w.propertyId, query }))[0]?.name ?? null;

describe("busqueda con el catalogo real de PM: el primer resultado es el producto correcto", () => {
  const casos: Array<[string, string]> = [
    ["cerveza Sol", "Sol"],
    ["quiero dos cervezas Sol", "Sol"],
    ["sol", "Sol"],
    ["coctel Margarita", "Margarita"],
    ["tacos al pastor", "Taco Al Pastor (individual)"],
    ["500g de arrachera", "Arrachera — 500 g"],
    ["medio kilo de bistec", "Bistec de Res — 500 g"],
    ["medio de pastor", "Pastor — 500 g"],
    ["un cuarto de kilo de bistec", "Bistec de Res — 250 g"],
    ["cuarto de bistec", "Bistec de Res — 250 g"],
    ["tres cuartos de chuleta", "Chuleta de Cerdo — 750 g"],
    ["tres cuartos de kilo de arrachera", "Arrachera — 750 g"],
    ["1kg de arrachera", "Arrachera — 1 kg"],
    ["1.5 kg de arrachera", "Arrachera — 1.5 kg"],
    ["orden de bistec", "Tacos de Bistec de Res (orden de 3)"],
    ["media orden de frijoles charros", "Frijoles Charros Normal (1/2 orden)"],
    ["heineken cero", "Heineken 0.0"],
    ["guacamole", "Guacamole"],
    ["extra guacamole", "Extra Guacamole"],
  ];
  for (const [consulta, esperado] of casos) {
    it(`"${consulta}" -> ${esperado}`, async () => {
      expect(await primero(consulta)).toBe(esperado);
    });
  }
  it("'3 kilos de pastor' ya no se reduce a 1 kg: trae todos los pesos para armar 2 kg + 1 kg", async () => {
    const r = (await searchProducts(w.repo, { propertyId: w.propertyId, query: "3 kilos de pastor" })).map((p) => p.name);
    expect(r).toContain("Pastor — 2 kg");
    expect(r).toContain("Pastor — 1 kg");
  });
  it("un producto que no existe sigue dando lista vacia (sushi)", async () => {
    expect(await primero("sushi")).toBeNull();
  });
});
