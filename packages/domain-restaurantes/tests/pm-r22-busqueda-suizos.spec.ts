// PM ronda 22, R5 (SIM-WA-248/061): «tacos suizos de pechuga (de pollo)» negaba «Suizo de Pechuga» aunque existe y esta disponible. Causa raiz: en las variantes relajadas
// (pollo -> pechuga) la comparacion es estricta contra el NOMBRE, y el menu pone el sustantivo generico «Tacos» en la CATEGORIA («Tacos Suizos»), no en el nombre.
import { describe, expect, it } from "vitest";
import { searchProducts } from "../src/orders.ts";
import type { RestaurantesRepository } from "../src/repository.ts";

const p = (name: string, categoryName: string, description: string | null = null, searchKeywords: string[] = []) => ({
  id: name, name, description, price: 100, categoryName, searchKeywords, packSize: null, noDomicilio: false,
});
const CATALOGO = [
  p("Suizo de Pechuga", "Tacos Suizos", "Orden de 5 tacos"),
  p("Suizo de Pastor", "Tacos Suizos", "Orden de 5 tacos"),
  p("Suizo de Bistec", "Tacos Suizos", "Orden de 5 tacos", ["bistek"]),
  p("Suizo de Arrachera", "Tacos Suizos", "Orden de 5 tacos"),
  p("Alambre Suizo de Pechuga", "Alambres", null),
  p("Tacos de Pechuga de Pollo (orden de 3)", "Tacos", "Orden de 3 tacos"),
  p("Tacos de Bistec de Res (orden de 3)", "Tacos", "Orden de 3 tacos", ["bistek"]),
  p("Tacos de Chuleta de Cerdo (orden de 3)", "Tacos", "Orden de 3 tacos"),
  p("Tacos de Costilla de Res (orden de 3)", "Tacos", "Orden de 3 tacos"),
  p("Tacos de Arrachera (orden de 3)", "Tacos", "Orden de 3 tacos"),
  p("Taco Al Pastor (individual)", "Tacos", null),
  p("Nachos de Pastor", "Nachos", null),
  p("Nachos de Pastor (1/2 orden)", "Nachos", null),
  p("Pastor — 1 kg", "Por kilo", null),
  p("Pastor — 500 g", "Por kilo", null),
  p("Orden Tortilla de Harina", "Extras", null),
  p("Horchata", "Aguas", null),
];
const repo = { listAvailableProductsForBranch: async () => CATALOGO } as unknown as RestaurantesRepository;
const buscar = async (query: string) => (await searchProducts(repo, { propertyId: "gl", query })).map((x) => x.name);

describe("R5: «tacos suizos de pechuga» existe como «Suizo de Pechuga»", () => {
  it.each([
    "tacos suizos de pechuga",
    "tacos suizos de pechuga de pollo",
    "una orden de tacos suizos de pechuga de pollo",
    "A domicilio, una orden de tacos suizos de pechuga de pollo y 3 tacos de arrachera",
    "taco suizo de pollo",
    "tacos suizos de pechuga (de pollo)",
  ])("%s -> encuentra Suizo de Pechuga", async (q) => {
    // El mensaje largo con dos pedidos lo parte el agente por producto; aqui solo se exige que la frase del suizo no lo niegue.
    const frase = q.replace(/^A domicilio, /, "").replace(/ y 3 tacos de arrachera$/, "");
    expect(await buscar(frase)).toContain("Suizo de Pechuga");
  });

  it("el hallazgo por sinonimo (pollo -> pechuga) va marcado ambiguo para que el agente confirme", async () => {
    const r = await searchProducts(repo, { propertyId: "gl", query: "tacos suizos de pollo" });
    expect(r.find((x) => x.name === "Suizo de Pechuga")?.ambiguo).toBe(true);
  });

  it.each([
    ["tacos suizos de pastor", "Suizo de Pastor"],
    ["taco suizo de bistek", "Suizo de Bistec"],
    ["tacos suizos de arrachera", "Suizo de Arrachera"],
    ["una orden de tacos de chuleta", "Tacos de Chuleta de Cerdo (orden de 3)"],
    ["media orden de nachos de pastor", "Nachos de Pastor (1/2 orden)"],
    ["1/2 orden de nachos de pastor", "Nachos de Pastor (1/2 orden)"],
    ["un kilo de pastor", "Pastor — 1 kg"],
    ["medio kilo de pastor", "Pastor — 500 g"],
    ["tacos de costilla", "Tacos de Costilla de Res (orden de 3)"],
    ["tacos de pechuga", "Tacos de Pechuga de Pollo (orden de 3)"],
    ["TACOS DE BISTÉ", "Tacos de Bistec de Res (orden de 3)"],
    ["una orden de tortilla de harina", "Orden Tortilla de Harina"],
  ])("%s -> %s", async (q, esperado) => {
    expect(await buscar(q)).toContain(esperado);
  });

  it("lo que NO existe sigue sin encontrarse (la categoria no inventa productos)", async () => {
    expect(await buscar("tacos suizos de pescado")).toEqual([]);
    expect(await buscar("tacos suizos de camaron")).toEqual([]);
    expect(await buscar("tacos de langosta")).toEqual([]);
    expect(await buscar("suizo de pollo con piña")).toEqual([]);
  });

  it("una palabra que solo esta en la categoria como subcadena no cuenta (solo palabra completa)", async () => {
    // «tac» es prefijo de «tacos» pero no una palabra de la categoria: no basta.
    expect(await buscar("tac suizos de pollo")).toEqual([]);
  });
});
