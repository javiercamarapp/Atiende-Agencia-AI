// T7-060 (ronda 5): «¿qué cuesta el kilo de carne al pastor?» no encontraba «Pastor — 1 kg» ($900): «carne» es una palabra generica que ningun platillo lleva en su nombre y todos los tokens
// son obligatorios, asi que la busqueda volvia vacia y el agente decia que no encontraba el precio. Se prueba con el catalogo REAL de PM.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { searchProducts } from "../src/orders.ts";
import { tokenizeForProductSearch } from "../src/product-search.ts";

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
const nombres = async (query: string) => (await searchProducts(w.repo, { propertyId: w.propertyId, query })).map((p) => p.name);

describe("T7-060: «carne» generica no vuelve vacia la busqueda del kilo", () => {
  it.each([
    ["kilo de carne al pastor", "Pastor — 1 kg"],
    ["el kilo de carne al pastor", "Pastor — 1 kg"],
    ["1 kg de carne de pastor", "Pastor — 1 kg"],
    ["medio kilo de carne al pastor", "Pastor — 500 g"],
    ["un cuarto de carne de pastor", "Pastor — 250 g"],
  ])("%s -> %s", async (consulta, esperado) => {
    expect((await nombres(consulta))[0]).toBe(esperado);
  });

  it("la tokenizacion descarta «carne» solo si queda algo mas que el peso", () => {
    expect(tokenizeForProductSearch("kilo de carne al pastor")).toEqual(["peso:1000", "pastor"]);
    expect(tokenizeForProductSearch("carne asada")).toEqual(["asada"]);
  });

  it("NEGATIVOS: «carne» sola o con solo el peso conserva «carne» (no se vuelve una busqueda de todo lo que pese un kilo)", () => {
    expect(tokenizeForProductSearch("carne")).toEqual(["carne"]);
    expect(tokenizeForProductSearch("kilo de carne")).toEqual(["peso:1000", "carne"]);
  });

  it("lo que ya funcionaba sigue igual: «kilo de pastor» y «kilo de bistec» siguen dando su presentacion", async () => {
    expect((await nombres("kilo de pastor"))[0]).toBe("Pastor — 1 kg");
    expect((await nombres("kilo de bistec"))[0]).toMatch(/^Bistec de Res.*1 kg$/);
  });
});
