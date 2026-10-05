// La tabla de trazabilidad (README.md de esta carpeta) no se pudre: cada codigo `ruta::nombre` debe apuntar a un archivo
// existente que contenga ese nombre literal; una fila marcada `it.fails` o `it.todo` debe citar una prueba que de verdad
// lo sea (si el lote que la arregla entra y alguien quita `.fails`, esta prueba obliga a actualizar la tabla), y todo caso
// X01-X58 y cada commit del historial tiene su fila.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..", "..", "..", "..");
const PREFIJOS: Readonly<Record<string, string>> = {
  "T/": "packages/domain-restaurantes/tests/",
  "A/": "apps/api/tests/",
  "R/": "packages/domain-restaurantes/tests/regresiones-original/",
  "S/": "scripts/",
};

const readme = readFileSync(join(AQUI, "README.md"), "utf8");
const filas = readme.split("\n").filter((l) => l.startsWith("|") && !/^\|[\s|-]+\|$/.test(l));

interface Cita {
  readonly fila: string;
  readonly ruta: string;
  readonly nombre: string;
}

function citasDe(fila: string): Cita[] {
  const citas: Cita[] = [];
  for (const m of fila.matchAll(/`([TARS]\/[^`:]+?)::([^`]+)`/g)) {
    const prefijo = m[1]!.slice(0, 2);
    citas.push({ fila, ruta: PREFIJOS[prefijo]! + m[1]!.slice(2), nombre: m[2]! });
  }
  return citas;
}

const citas = filas.flatMap(citasDe);

describe("README de regresiones-original: la tabla de trazabilidad dice la verdad", () => {
  it("tiene citas y todas apuntan a un archivo existente", () => {
    expect(citas.length).toBeGreaterThan(150);
    const faltantes = citas.filter((c) => !existsSync(join(RAIZ, c.ruta))).map((c) => c.ruta);
    expect([...new Set(faltantes)]).toEqual([]);
  });

  it("cada nombre citado aparece literalmente en su archivo", () => {
    const huerfanas = citas.filter((c) => existsSync(join(RAIZ, c.ruta)) && !readFileSync(join(RAIZ, c.ruta), "utf8").includes(c.nombre)).map((c) => `${c.ruta} :: ${c.nombre}`);
    expect(huerfanas).toEqual([]);
  });

  it("una fila marcada it.fails cita al menos una prueba declarada con it.fails; una marcada it.todo, una con it.todo", () => {
    const incumplidas: string[] = [];
    for (const fila of filas) {
      const marcas = ["it.fails", "it.todo"].filter((m) => new RegExp(`\\| *(?:[^|]*\\b)?${m.replace(".", "\\.")}\\b[^|]*\\|\\s*$`).test(fila));
      for (const marca of marcas) {
        const lineas = citasDe(fila).flatMap((c) => (existsSync(join(RAIZ, c.ruta)) ? readFileSync(join(RAIZ, c.ruta), "utf8").split("\n").filter((l) => l.includes(c.nombre)) : []));
        if (!lineas.some((l) => l.includes(`${marca}(`))) incumplidas.push(`${marca}: ${fila.slice(0, 120)}`);
      }
    }
    expect(incumplidas).toEqual([]);
  });

  it("todo caso X01-X58 tiene su fila", () => {
    const ids = Array.from({ length: 58 }, (_, i) => `X${String(i + 1).padStart(2, "0")}`);
    const sinFila = ids.filter((id) => !filas.some((f) => f.startsWith(`| ${id} |`)));
    expect(sinFila).toEqual([]);
  });

  it("todo commit del historial del original tiene su fila", () => {
    const commits = ["6d07364", "cec17f1", "ff76358", "c25e70c", "abc543a", "0a346be", "72fd6ad", "de885b1", "5d164ee", "da4ce92", "0c0bebf", "03555e2", "3571c1c", "5710a5f", "609c3d6", "05a9798", "6091e17", "10d3485", "9460a3e", "e1ccae0", "cbad752", "c2154a5", "1cd7226", "34c2696"];
    const sinFila = commits.filter((c) => !filas.some((f) => f.startsWith(`| \`${c}\``)));
    expect(sinFila).toEqual([]);
  });
});
