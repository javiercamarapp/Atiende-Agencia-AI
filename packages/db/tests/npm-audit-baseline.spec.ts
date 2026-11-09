import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { avisosAltos, evaluarAudit, type Baseline } from "../../../scripts/npm-audit-baseline/check.ts";

// Trinquete de npm audit (Ola 2, F.4): producción sin high/critical; árbol completo sin avisos nuevos fuera del
// baseline. Reportes sintéticos con la forma de `npm audit --json` (v2).

const via = (ghsa: string, name: string, severity: string) => ({ url: `https://github.com/advisories/${ghsa}`, name, severity, title: `t ${ghsa}` });
const reporte = (...vias: ReturnType<typeof via>[]) => ({ vulnerabilities: Object.fromEntries(vias.map((v, i) => [`${v.name}-${i}`, { via: [v, "otro-paquete"] }])) });
const VACIO = { vulnerabilities: {} };
const BASE: Baseline = { avisos: [{ ghsa: "GHSA-aaaa-bbbb-cccc", paquete: "vite", severidad: "high", motivo: "dev" }] };

describe("npm-audit-baseline", () => {
  it("solo cuenta high/critical, por GHSA y sin duplicados", () => {
    const r = reporte(via("GHSA-aaaa-bbbb-cccc", "vite", "high"), via("GHSA-aaaa-bbbb-cccc", "vite", "high"), via("GHSA-mmmm-oooo-dddd", "x", "moderate"));
    expect(avisosAltos(r).map((a) => a.ghsa)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("pasa con el árbol completo dentro del baseline y producción limpia", () => {
    expect(evaluarAudit(VACIO, reporte(via("GHSA-aaaa-bbbb-cccc", "vite", "high")), BASE).ok).toBe(true);
  });

  it("falla con un high/critical nuevo en el árbol completo", () => {
    const v = evaluarAudit(VACIO, reporte(via("GHSA-aaaa-bbbb-cccc", "vite", "high"), via("GHSA-nnnn-uuuu-eeee", "lodash", "critical")), BASE);
    expect(v.ok).toBe(false);
    expect(v.nuevos.map((a) => a.ghsa)).toEqual(["GHSA-nnnn-uuuu-eeee"]);
  });

  it("falla con cualquier high en producción aunque esté en el baseline", () => {
    const enProd = reporte(via("GHSA-aaaa-bbbb-cccc", "vite", "high"));
    expect(evaluarAudit(enProd, enProd, BASE).ok).toBe(false);
  });

  it("reporta los avisos del baseline que ya no aparecen para retirarlos", () => {
    expect(evaluarAudit(VACIO, VACIO, BASE).retirables).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("el baseline versionado solo trae high/critical con motivo", () => {
    const b = JSON.parse(readFileSync(path.resolve(__dirname, "../../../scripts/npm-audit-baseline/baseline.json"), "utf8")) as Baseline;
    for (const a of b.avisos) {
      expect(a.ghsa).toMatch(/^GHSA-/);
      expect(["high", "critical"]).toContain(a.severidad);
      expect(a.motivo.length).toBeGreaterThan(10);
    }
  });
});
