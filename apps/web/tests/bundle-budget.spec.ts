import { describe, expect, it } from "vitest";
import { chunksDeRuta, evaluarPresupuesto, type Manifest } from "../../../scripts/verify-bundle-budget/check-bundle-budget.ts";

const manifest: Manifest = {
  "index.html": { file: "assets/index.js", isEntry: true, dynamicImports: ["src/Pedir.tsx", "src/Panel.tsx"] },
  "src/Pedir.tsx": { file: "assets/Pedir.js", imports: ["_vendor.js"] },
  "src/Panel.tsx": { file: "assets/Panel.js", imports: ["_vendor.js", "_grafica.js"] },
  "_vendor.js": { file: "assets/vendor.js" },
  "_grafica.js": { file: "assets/grafica.js", imports: ["_vendor.js"] },
  "_estilos.css": { file: "assets/estilos.css" },
};
const tam: Record<string, number> = { "assets/index.js": 100, "assets/Pedir.js": 20, "assets/Panel.js": 500, "assets/vendor.js": 30, "assets/grafica.js": 400 };

describe("presupuesto de bundle (R-37)", () => {
  it("una ruta cuenta su chunk y sus imports estaticos transitivos, una sola vez, sin las rutas dinamicas", () => {
    expect(chunksDeRuta(manifest, "src/Panel.tsx").sort()).toEqual(["assets/Panel.js", "assets/grafica.js", "assets/vendor.js"]);
    expect(chunksDeRuta(manifest, "index.html")).toEqual(["assets/index.js"]);
  });

  it("una ruta publica ligera no paga el peso del panel", () => {
    const [pedir] = evaluarPresupuesto(manifest, { rutas: [{ clave: "src/Pedir.tsx", nombre: "pedir", maxGzipBytes: 60 }] }, (f) => tam[f]!);
    expect(pedir).toMatchObject({ gzipBytes: 50, ok: true, chunks: 2 });
  });

  it("falla cuando una ruta excede su tope", () => {
    const [panel] = evaluarPresupuesto(manifest, { rutas: [{ clave: "src/Panel.tsx", nombre: "panel", maxGzipBytes: 900 }] }, (f) => tam[f]!);
    expect(panel).toMatchObject({ gzipBytes: 930, ok: false });
  });

  it("una clave inexistente en el manifiesto es error explicito, no un 0 silencioso", () => {
    expect(() => chunksDeRuta(manifest, "src/Borrada.tsx")).toThrow(/no esta en el manifiesto/);
  });

  it("un import que falta en el manifiesto es error explicito", () => {
    expect(() => chunksDeRuta({ a: { file: "a.js", imports: ["b"] } }, "a")).toThrow(/no existe/);
  });
});
