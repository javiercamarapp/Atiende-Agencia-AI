// La migración 026 repite en SQL las categorías contables del clasificador: este test impide que se desincronicen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORIAS_CONTABLES, CATEGORIAS_GRUESAS } from "../src/bookkeeping/clasificacion-cfdi.ts";
import { DEFAULT_MAPPINGS } from "../src/bookkeeping/catalogo.ts";

const SQL = readFileSync(new URL("../migrations/026_despachos_clasificacion_ingesta_libro.sql", import.meta.url), "utf8");

function listaDeCheck(nombre: string): string[] {
  const inicio = SQL.indexOf(`add constraint ${nombre} check (`);
  expect(inicio, nombre).toBeGreaterThan(-1);
  const fin = SQL.indexOf("));", inicio);
  return [...SQL.slice(inicio, fin).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("migración 026 vs. clasificador TypeScript", () => {
  it("el CHECK de invoice_classification.categoria = categorías gruesas históricas + finas del catálogo + otros", () => {
    const sql = new Set(listaDeCheck("invoice_classification_categoria_check"));
    expect([...sql].sort()).toEqual([...new Set([...CATEGORIAS_GRUESAS, ...CATEGORIAS_CONTABLES])].sort());
  });

  it("el CHECK de clasificacion_correccion.categoria = las finas (sin las gruesas históricas)", () => {
    const bloque = SQL.slice(SQL.indexOf("create table despachos.clasificacion_correccion"), SQL.indexOf("alter table despachos.clasificacion_correccion enable"));
    const lista = [...bloque.slice(bloque.indexOf("categoria text not null check (")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...new Set(lista)].sort()).toEqual([...CATEGORIAS_CONTABLES].sort());
  });

  it("todas las categorías finas de gasto tienen mapeo de póliza", () => {
    for (const cat of CATEGORIAS_CONTABLES.filter((c) => !c.startsWith("venta_"))) expect(DEFAULT_MAPPINGS[`I|${cat}`], cat).toBeDefined();
  });
});
