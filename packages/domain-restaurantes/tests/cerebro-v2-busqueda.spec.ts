// API pública de cerebro-v2/busqueda (buscarEnCatalogo) + comparación contra el buscador actual del monorrepo
// (orders.ts searchProducts sobre product-search.ts) con casos medidos del suelto. La comparación DOCUMENTA qué casos del suelto
// fallan hoy con el buscador del monorrepo: si alguien mejora el del monorrepo, la lista fija de abajo se queda corta y la prueba
// avisa (hay que actualizarla), no se rompe en silencio.
import { describe, expect, it } from "vitest";
import { buscarEnCatalogo, filasDeCatalogo, resultadoBuscarProducto, type BusquedaConExtras, type ProductoCatalogo } from "../src/whatsapp/cerebro-v2/busqueda.ts";
import { searchProducts } from "../src/orders.ts";
import type { RestaurantesRepository } from "../src/repository.ts";
import menu from "./cerebro-v2-busqueda-menu-pm.json" with { type: "json" };

const CATALOGO = (menu as unknown as Record<string, ProductoCatalogo[]>)["garcia-lavin"] ?? [];

function conExtras(q: string): BusquedaConExtras {
  const r = buscarEnCatalogo(q, CATALOGO);
  return Array.isArray(r) ? { productos: r, extras_disponibles: [] } : r;
}

async function monorrepo(q: string): Promise<string[]> {
  const repo = {
    listAvailableProductsForBranch: () =>
      Promise.resolve(CATALOGO.map((p) => ({ id: p.id, name: p.name, description: p.description ?? null, categoryName: p.category ?? null, searchKeywords: p.searchKeywords ?? [], price: p.price, isAvailable: true }))),
  } as unknown as RestaurantesRepository;
  return (await searchProducts(repo, { propertyId: "b1", query: q })).map((p) => p.name);
}

describe("buscarEnCatalogo (API pública)", () => {
  it("lista ordenada sin extras; con «con X» de pago devuelve { productos, extras_disponibles }", () => {
    const solo = buscarEnCatalogo("horchata", CATALOGO);
    expect(Array.isArray(solo)).toBe(true);
    const conGuac = buscarEnCatalogo("tacos de pastor con guacamole", CATALOGO);
    expect(Array.isArray(conGuac)).toBe(false);
    if (!Array.isArray(conGuac)) {
      expect(conGuac.extras_disponibles).toEqual([expect.objectContaining({ nombre: "Extra Guacamole", precio: 49 })]);
      expect(conGuac.productos.every((p) => !/^Extra /.test(p.name))).toBe(true);
    }
    expect(buscarEnCatalogo("tacos de pastor con guacamole", CATALOGO, { conExtras: false }).every((p) => !/^Extra /.test(p.name))).toBe(true);
  });
  it("los productos no disponibles no entran; acentos y mayúsculas no importan", () => {
    const cat: ProductoCatalogo[] = [
      { id: "p1", name: "Francés Suizo de Pastor", price: 100, category: "Francés Suizo" },
      { id: "p2", name: "Taco Al Pastor (individual)", price: 20, category: "Tacos" },
      { id: "p3", name: "Francés Suizo de Bistec", price: 100, category: "Francés Suizo", available: false },
    ];
    expect(filasDeCatalogo(cat)).toHaveLength(2);
    for (const q of ["frances suizo de pastor", "FRANCES SUIZO pastor"]) {
      expect(buscarEnCatalogo(q, cat, { conExtras: false }).map((p) => p.id)).toEqual(["p1"]);
    }
    expect(buscarEnCatalogo("frances suizo de bistec", cat, { conExtras: false })).toEqual([]);
  });
  it("resultadoBuscarProducto: lista si no hay extras ni otros productos", () => {
    expect(resultadoBuscarProducto({ productos: [], extras_disponibles: [] })).toEqual([]);
    const conOtros = { productos: [], extras_disponibles: [], otros_productos: [{ texto: "una coca", resultados: [] }] };
    expect(resultadoBuscarProducto(conOtros)).toBe(conOtros);
  });
});

type Caso = { q: string; ok: (nombres: string[], todo?: BusquedaConExtras) => boolean };
const primero = (re: RegExp) => (n: string[]) => n.length > 0 && re.test(n[0] ?? "");
const incluye = (re: RegExp) => (n: string[]) => n.some((x) => re.test(x));
const CASOS: Caso[] = [
  { q: "heineken cero cero", ok: incluye(/^Heineken 0\.0$/) },
  { q: "heineken 00", ok: incluye(/^Heineken 0\.0$/) },
  { q: "heineken 0 0", ok: incluye(/^Heineken 0\.0$/) },
  { q: "cerveza sin alcohol", ok: incluye(/^Heineken 0\.0$/) },
  { q: "cero cero", ok: incluye(/^Heineken 0\.0$/) },
  { q: "heineken sin alcohol", ok: incluye(/^Heineken 0\.0$/) },
  { q: "bistec por kilo", ok: incluye(/^Bistec de Res — 1 kg/) },
  { q: "bistec normal por kilo", ok: incluye(/^Bistec de Res — 1 kg/) },
  { q: "un kilo de bistec", ok: incluye(/^Bistec de Res — 1 kg/) },
  { q: "horchata grande", ok: primero(/^Horchata$/) },
  { q: "coca cola grande", ok: primero(/^Coca-Cola$/) },
  { q: "sushi de pollo", ok: (n) => n.length === 0 },
  { q: "tacos de lengua", ok: (n) => n.length === 0 },
  { q: "té frío", ok: (n) => n.length === 1 && n[0] === "Té" },
  { q: "mole", ok: (n) => !n.some((x) => /guacamole|bistec|tecate|tequila/i.test(x)) },
  { q: "sol", ok: (n) => n.includes("Sol") && !n.some((x) => /solera/i.test(x)) },
  { q: "grinbas", ok: (n) => n.length > 0 && n.every((x) => /gringa/i.test(x)) },
  { q: "sprite cero cero", ok: primero(/^Sprite Cero$/) },
  { q: "coca 0 0", ok: primero(/^Coca-Cola/) },
  { q: "agua mineral sin gas", ok: primero(/^Agua Mineral Cristal$/) },
  { q: "coca sin azucar", ok: primero(/^Coca-Cola sin Azúcar$/) },
  { q: "guacamole", ok: primero(/^Guacamole$/) },
  { q: "medio kilo de pastor", ok: incluye(/Pastor — 500 g/) },
  { q: "tacos de pastor sin cebolla", ok: primero(/pastor/i) },
  { q: "tacos de pastor con guacamole", ok: (n, t) => primero(/pastor/i)(n) && (t ? t.extras_disponibles.some((e) => e.nombre === "Extra Guacamole") : n.includes("Extra Guacamole")) },
  { q: "tacos de pastor y una coca", ok: (n, t) => primero(/pastor/i)(n) && (t ? (t.otros_productos ?? []).some((o) => o.resultados.some((r) => /^Coca-Cola/.test(r.name))) : n.some((x) => /^Coca-Cola/.test(x))) },
  { q: "una coca para llevar", ok: primero(/^Coca-Cola/) },
  { q: "dos tacos de pastor para mi esposa", ok: primero(/pastor/i) },
];

// Casos del suelto que HOY fallan con el buscador del monorrepo (searchProducts). Observado el 6-nov-2026 al portar.
const FALLAN_EN_MONORREPO_HOY: readonly string[] = [
  "heineken 00",
  "bistec por kilo",
  "bistec normal por kilo",
  "horchata grande",
  "coca cola grande",
  "té frío",
  "mole",
  "sol",
  "grinbas",
  "sprite cero cero",
  "agua mineral sin gas",
  "tacos de pastor con guacamole",
  "tacos de pastor y una coca",
  "una coca para llevar",
  "dos tacos de pastor para mi esposa",
];

describe("suelto vs. monorrepo (product-search.ts)", () => {
  it.each(CASOS.map((c) => [c.q, c] as const))("el port cumple «%s»", (_q, c) => {
    const t = conExtras(c.q);
    expect(c.ok(t.productos.map((p) => p.name), t), JSON.stringify(t.productos.map((p) => p.name))).toBe(true);
  });
  it("lista de casos que fallan con el buscador del monorrepo", async () => {
    const fallan: string[] = [];
    for (const c of CASOS) if (!c.ok(await monorrepo(c.q))) fallan.push(c.q);
    expect(fallan).toEqual(FALLAN_EN_MONORREPO_HOY);
  });
});
