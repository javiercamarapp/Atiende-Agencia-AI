// Conjunto dorado del clasificador (D-P3-13): reporta el porcentaje en CI. Umbral inicial: NO bloquea (solo reporta) hasta que Javier fije el
// umbral; la variable EVAL_CLASIFICADOR_UMBRAL (0-100, vacía = no bloquea) permite ensayarlo. Lo que SÍ se exige aquí es la estructura del
// conjunto (>= 100 casos, ids únicos, todo categoría válida) y el invariante «un empate siempre va a revisión».
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASOS_CLASIFICADOR, correrConjuntoDorado, formatearReporte } from "../src/evals/clasificador/ejecutor.ts";
import { CATEGORIAS_CONTABLES } from "../src/bookkeeping/clasificacion-cfdi.ts";

describe("conjunto dorado del clasificador", () => {
  it("tiene al menos 100 casos, ids únicos y categorías esperadas que existen en el catálogo", () => {
    expect(CASOS_CLASIFICADOR.length).toBeGreaterThanOrEqual(100);
    expect(new Set(CASOS_CLASIFICADOR.map((c) => c.id)).size).toBe(CASOS_CLASIFICADOR.length);
    for (const c of CASOS_CLASIFICADOR) {
      if (c.categoriaEsperada !== null) expect(CATEGORIAS_CONTABLES, c.id).toContain(c.categoriaEsperada);
      expect(c.descripcion.trim().length, c.id).toBeGreaterThan(0);
    }
    expect(CASOS_CLASIFICADOR.some((c) => c.debeIrARevision)).toBe(true);
    expect(CASOS_CLASIFICADOR.some((c) => c.claveProdServ)).toBe(true);
  });

  it("reporta el porcentaje y cumple el invariante: todo empate va a revisión", () => {
    const { reporte } = correrConjuntoDorado();
    const texto = formatearReporte(reporte);
    console.log(`\n${texto}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Clasificador de despachos\n\n\`\`\`\n${texto}\n\`\`\`\n`);
      } catch {
        // el resumen del job es opcional
      }
    }
    expect(reporte.empates).toBeGreaterThan(0);
    expect(reporte.porcentajeEmpateARevision).toBe(100);
    const umbral = Number(process.env.EVAL_CLASIFICADOR_UMBRAL);
    if (process.env.EVAL_CLASIFICADOR_UMBRAL && Number.isFinite(umbral)) expect(reporte.porcentajeAciertoCategoria).toBeGreaterThanOrEqual(umbral);
  });
});
