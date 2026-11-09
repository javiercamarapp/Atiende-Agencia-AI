// Guard barato de las pruebas de navegador: `page.waitForTimeout(ms)` adivina cuanto tarda algo (se queda corto en CI o alarga la suite
// en balde). En apps/web/e2e no queda ninguno: se espera por condicion (aserciones web-first, expect.poll, waitForResponse,
// waitForFunction o los helpers de e2e/helpers/esperas.ts). En apps/web/e2e-ds3 quedan los de dos specs existentes que la regla
// «los specs solo se agregan» (scripts/diseno/solo-agrega-specs.sh) no deja tocar: es un trinquete que solo baja.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LLAMADA = /\bwaitForTimeout\s*\(/g;

/** Restantes permitidos en e2e-ds3 (ruta relativa a apps/web -> maximo). Al quitar uno, baja el numero; al llegar a 0, borra la entrada. */
const RESTANTES_DS3: Readonly<Record<string, number>> = {
  // ventanas de medicion de carga/fps y CLS (la espera ES la medida) y transiciones del diseno ds3
  "e2e-ds3/carga-y-fps.spec.ts": 8,
  // entrada de pagina y transicion de ancho del panel del Copiloto antes de medir el marco
  "e2e-ds3/marco-shell.spec.ts": 2,
};

function archivos(dir: string): string[] {
  return readdirSync(path.join(web, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" ? [] : archivos(rel);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) ? [rel] : [];
  });
}

function conteo(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rel of archivos(dir)) {
    const n = (readFileSync(path.join(web, rel), "utf8").match(LLAMADA) ?? []).length;
    if (n > 0) out[rel] = n;
  }
  return out;
}

describe("pruebas de navegador sin waitForTimeout", () => {
  it("apps/web/e2e no tiene ningun waitForTimeout (espera por condicion)", () => {
    expect(conteo("e2e")).toEqual({});
  });

  it("apps/web/e2e-ds3 no suma waitForTimeout: solo los restantes conocidos, y el trinquete baja cuando se quitan", () => {
    const actual = conteo("e2e-ds3");
    const subieron = Object.entries(actual)
      .filter(([rel, n]) => n > (RESTANTES_DS3[rel] ?? 0))
      .map(([rel, n]) => `${rel}: ${n} (maximo ${RESTANTES_DS3[rel] ?? 0}); espera por condicion en vez de waitForTimeout`);
    expect(subieron).toEqual([]);
    const bajaron = Object.entries(RESTANTES_DS3)
      .filter(([rel, max]) => (actual[rel] ?? 0) < max)
      .map(([rel, max]) => `${rel}: quedan ${actual[rel] ?? 0} y el maximo es ${max}; baja RESTANTES_DS3 en este archivo`);
    expect(bajaron).toEqual([]);
  });

  it("el detector reconoce la llamada y no un comentario que la nombra sin parentesis", () => {
    expect("await page.waitForTimeout(300);".match(LLAMADA)).toHaveLength(1);
    expect("await page.waitForTimeout (300);".match(LLAMADA)).toHaveLength(1);
    expect("// en lugar de `page.waitForTimeout`".match(LLAMADA)).toBeNull();
  });
});
