// Trinquete de axe (apps/web/e2e-ds3/axe-trinquete.ts): la logica que decide si e2e-ds3/axe.spec.ts falla, probada sin navegador, y el
// formato real de e2e-ds3/axe-baseline.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claveAxe, compararConBaseline, ETIQUETAS_WCAG, leerBaseline, ordenarEntradas } from "../e2e-ds3/axe-trinquete.ts";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const R = claveAxe("/citas/login", "d1440-claro");
const OTRA = claveAxe("/citas/login", "d1440-oscuro");

describe("compararConBaseline", () => {
  it("sin violaciones y baseline vacia: pasa", () => {
    expect(compararConBaseline(R, [], [])).toEqual({ nuevas: [], bajaron: [] });
  });

  it("una violacion que no esta en la baseline falla", () => {
    const r = compararConBaseline(R, [{ ruta: R, regla: "color-contrast", nodos: 2 }], []);
    expect(r.nuevas).toEqual([`${R} [color-contrast] 2 nodo(s): violacion nueva (no esta en axe-baseline.json)`]);
    expect(r.bajaron).toEqual([]);
  });

  it("la misma regla con mas nodos que la baseline falla; con los mismos pasa", () => {
    const base = [{ ruta: R, regla: "label", nodos: 1 }];
    expect(compararConBaseline(R, [{ ruta: R, regla: "label", nodos: 3 }], base).nuevas).toEqual([`${R} [label] sube de 1 a 3 nodo(s)`]);
    expect(compararConBaseline(R, [{ ruta: R, regla: "label", nodos: 1 }], base)).toEqual({ nuevas: [], bajaron: [] });
  });

  it("una entrada que bajo o desaparecio pide bajar la baseline", () => {
    const base = [
      { ruta: R, regla: "label", nodos: 3 },
      { ruta: R, regla: "region", nodos: 1 },
    ];
    const r = compararConBaseline(R, [{ ruta: R, regla: "label", nodos: 2 }], base);
    expect(r.nuevas).toEqual([]);
    expect(r.bajaron).toEqual([
      `${R} [label] bajo de 3 a 2 nodo(s): baja axe-baseline.json a 2`,
      `${R} [region] ya no tiene violaciones: borra la entrada de axe-baseline.json`,
    ]);
  });

  it("solo mira las entradas de su ruta y proyecto (otra pantalla o tema no cuenta)", () => {
    const base = [{ ruta: OTRA, regla: "color-contrast", nodos: 4 }];
    expect(compararConBaseline(R, [], base)).toEqual({ nuevas: [], bajaron: [] });
    expect(compararConBaseline(R, [{ ruta: R, regla: "color-contrast", nodos: 1 }], base).nuevas).toHaveLength(1);
  });
});

describe("leerBaseline", () => {
  it("acepta [] y entradas {ruta, regla, nodos}", () => {
    expect(leerBaseline("[]")).toEqual([]);
    expect(leerBaseline(JSON.stringify([{ ruta: R, regla: "label", nodos: 1 }]))).toEqual([{ ruta: R, regla: "label", nodos: 1 }]);
  });

  it.each([
    ["no es lista", "{}"],
    ["llave de mas", JSON.stringify([{ ruta: R, regla: "label", nodos: 1, nota: "x" }])],
    ["sin nodos", JSON.stringify([{ ruta: R, regla: "label" }])],
    ["nodos 0", JSON.stringify([{ ruta: R, regla: "label", nodos: 0 }])],
    ["nodos decimal", JSON.stringify([{ ruta: R, regla: "label", nodos: 1.5 }])],
    ["regla vacia", JSON.stringify([{ ruta: R, regla: "", nodos: 1 }])],
    ["duplicada", JSON.stringify([{ ruta: R, regla: "label", nodos: 1 }, { ruta: R, regla: "label", nodos: 2 }])],
  ])("rechaza %s", (_nombre, texto) => {
    expect(() => leerBaseline(texto)).toThrow(/axe-baseline\.json/);
  });

  it("la baseline real del repo tiene el formato valido y esta ordenada por ruta y regla", () => {
    const real = leerBaseline(readFileSync(path.join(aqui, "..", "e2e-ds3", "axe-baseline.json"), "utf8"));
    expect(real).toEqual(ordenarEntradas(real));
  });
});

it("audita WCAG 2.0, 2.1 y 2.2 en A y AA", () => {
  expect([...ETIQUETAS_WCAG]).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
});
