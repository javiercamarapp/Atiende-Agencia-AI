// ds3 / 0.2 -- trinquete de la bandera del diseno nuevo. Cuenta las referencias en codigo a `DISENO_DS3` y a `data-diseno`
// (JS/TS de produccion; el CSS por feature vive bajo `html[data-diseno="ds3"]` y no cuenta, y la definicion y el barril
// quedan fuera). El plan limita las ramas estructurales de JS: este numero NO puede subir (baseline en
// diseno-bandera-baseline.json) y, cuando baja, el baseline baja con el. El retiro de la bandera lo deja en 0.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const raizRepo = path.resolve(here, "..", "..", "..");
const baseline = JSON.parse(readFileSync(path.join(here, "diseno-bandera-baseline.json"), "utf8")) as { referencias: number };

const RAICES = ["apps/web/src", "packages/ui/src"];
/** Infraestructura de la bandera: definicion y barril. No son ramas de diseno. */
const EXCLUIDOS = new Set(["packages/ui/src/lib/diseno.ts", "packages/ui/src/index.ts"]);
const PATRON = /DISENO_DS3|data-diseno/g;

function archivos(dir: string, salida: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    if (nombre === "node_modules" || nombre === "dist") continue;
    const ruta = path.join(dir, nombre);
    if (statSync(ruta).isDirectory()) archivos(ruta, salida);
    else if (/\.(ts|tsx)$/.test(nombre) && !/\.(spec|test)\.tsx?$/.test(nombre)) salida.push(ruta);
  }
  return salida;
}

/** Referencias en lineas de codigo (se ignoran las lineas de puro comentario). */
function contarReferencias(texto: string): number {
  let n = 0;
  for (const linea of texto.split("\n")) {
    if (/^\s*(\/\/|\/\*|\*)/.test(linea)) continue;
    n += linea.match(PATRON)?.length ?? 0;
  }
  return n;
}

function escanear(): { total: number; porArchivo: Record<string, number>; leidos: number } {
  const porArchivo: Record<string, number> = {};
  let total = 0;
  let leidos = 0;
  for (const raiz of RAICES) {
    for (const abs of archivos(path.join(raizRepo, raiz))) {
      const rel = path.relative(raizRepo, abs).split(path.sep).join("/");
      if (EXCLUIDOS.has(rel)) continue;
      leidos++;
      const n = contarReferencias(readFileSync(abs, "utf8"));
      if (n > 0) {
        porArchivo[rel] = n;
        total += n;
      }
    }
  }
  return { total, porArchivo, leidos };
}

describe("trinquete de la bandera de diseno (ds3)", () => {
  const { total, porArchivo, leidos } = escanear();

  it("el baseline es un entero valido y el escaneo leyo codigo (no pasa en vacio)", () => {
    expect(Number.isInteger(baseline.referencias) && baseline.referencias >= 0).toBe(true);
    expect(leidos).toBeGreaterThan(300);
  });

  it("el contador detecta referencias en codigo y no en comentarios (sanidad)", () => {
    expect(contarReferencias("if (DISENO_DS3) { x(); }")).toBe(1);
    expect(contarReferencias('<div data-diseno="ds3" className="a">')).toBe(1);
    expect(contarReferencias("// DISENO_DS3 solo en comentario\n * data-diseno tambien")).toBe(0);
  });

  it("las referencias no suben por encima del baseline (usa CSS bajo html[data-diseno] en vez de una rama de JS nueva)", () => {
    expect(total, `hay ${total} referencias y el baseline es ${baseline.referencias}: ${JSON.stringify(porArchivo)}`).toBeLessThanOrEqual(baseline.referencias);
  });

  it("cuando el numero baja, el baseline debe bajar con el (el piso solo desciende)", () => {
    expect(baseline.referencias - total, `bajaste a ${total}: baja diseno-bandera-baseline.json de ${baseline.referencias} a ${total}`).toBeLessThanOrEqual(0);
  });
});
