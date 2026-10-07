// PL-23 -- test-guard de rutas: las rutas de catalogo, promociones y sucursales piden una ACCION de la matriz
// (`assertAccion`), nunca una lista de roles; y ninguna ruta admin de restaurantes pasa una lista suelta de roles a `assertVerticalRole`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCIONES_RESTAURANTES_LISTA } from "@atiende/domain-restaurantes";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/routes/verticals/restaurantes");
const leer = (f: string) => readFileSync(join(DIR, f), "utf8");
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("PL-23 guard de rutas admin de restaurantes", () => {
  it("catalogo, promociones y sucursales usan solo assertAccion (sin assertVerticalRole ni listas de roles)", () => {
    for (const f of ["admin-catalog.ts", "admin-promotions.ts", "admin-branches.ts"]) {
      const src = sinComentarios(leer(f));
      expect(src, f).not.toMatch(/assertVerticalRole/);
      expect(src, f).not.toMatch(/MANAGER_ROLES|STAFF_INVITE_ROLES|REPARTIDOR_ROLES/);
      expect(src, f).toMatch(/assertAccion\(c, "/);
    }
  });

  it("ninguna ruta admin pasa una lista suelta de roles a assertVerticalRole", () => {
    const sueltas: string[] = [];
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".ts"))) {
      const src = sinComentarios(leer(f));
      if (/assertVerticalRole\(\s*c\s*,\s*(\[|\()/.test(src) || /assertVerticalRole\(\s*c\s*,\s*["'`]/.test(src)) sueltas.push(f);
    }
    expect(sueltas).toEqual([]);
  });

  it("cada accion citada en assertAccion existe en la matriz y cada accion de catalogo/promociones/sucursal esta usada por alguna ruta", () => {
    const usadas = new Set<string>();
    for (const f of ["admin-catalog.ts", "admin-promotions.ts", "admin-branches.ts"]) {
      for (const m of sinComentarios(leer(f)).matchAll(/assertAccion\(c, (?:cambiaPrecio \? )?"([^"]+)"(?: : "([^"]+)")?\)/g)) {
        usadas.add(m[1]!);
        if (m[2]) usadas.add(m[2]);
      }
    }
    for (const a of usadas) expect(ACCIONES_RESTAURANTES_LISTA as readonly string[]).toContain(a);
    for (const a of ACCIONES_RESTAURANTES_LISTA.filter((x) => /^(catalogo|promociones|sucursal)\./.test(x))) expect([...usadas]).toContain(a);
  });
});
