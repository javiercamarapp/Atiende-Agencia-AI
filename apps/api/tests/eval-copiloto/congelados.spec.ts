import { describe, expect, it } from "vitest";
import { scriptedCompletion } from "@atiende/agent-core/data-chat";
import { CATEGORIAS_CASO, REPARTO_CATEGORIAS, PresupuestoDuro, candidatoPorId, correrEval } from "@atiende/agent-core/data-chat/evals";
import { parseArgs } from "@atiende/agent-core/data-chat";
import { CONFIG, VERTICALES_EVAL, mundoRepeticion, type VerticalEval } from "../../../../scripts/eval-copiloto/mundos.ts";
import { cargarFuente, leerCongelado } from "../../../../scripts/eval-copiloto/congelado.ts";
import { guionOro } from "../../../../scripts/eval-copiloto/ejecutar.ts";

const PREFIJO: Record<VerticalEval, string> = { restaurantes: "RES", hoteles: "HOT", rentas: "REN", despachos: "DES", licitaciones: "LIC", citas: "CIT" };

describe.each(VERTICALES_EVAL)("casos congelados de %s", (v) => {
  const congelado = leerCongelado(v);
  const catalogo = CONFIG[v].sinBase();

  it("60 casos con id unico y prefijo de la vertical, reparto por categoria del plan", () => {
    expect(congelado.casos).toHaveLength(60);
    expect(new Set(congelado.casos.map((c) => c.id)).size).toBe(60);
    for (const c of congelado.casos) expect(c.id.startsWith(`${PREFIJO[v]}-`)).toBe(true);
    const cuenta = (cat: string) => congelado.casos.filter((c) => c.categoria === cat).length;
    // 60 casos: el reparto del plan (30/15/15/10/8/10/7/5 %) redondeado a enteros
    expect(CATEGORIAS_CASO.map(cuenta)).toEqual([18, 9, 9, 6, 5, 6, 4, 3]);
    expect(Object.values(REPARTO_CATEGORIAS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("cada herramienta esperada existe en el catalogo REAL y sus argumentos pasan el esquema estricto del motor", () => {
    const tools = new Map(catalogo.tools.map((t) => [t.name, t]));
    for (const c of congelado.casos) {
      for (const l of c.esperado.llamadas) {
        const t = tools.get(l.tool);
        expect(t, `${c.id}: ${l.tool}`).toBeDefined();
        expect(parseArgs(t!.params, l.args).ok, `${c.id}: ${JSON.stringify(l.args)}`).toBe(true);
      }
    }
  });

  it("el archivo congelado corresponde a las preguntas escritas en casos/ (sin drift de fuente)", async () => {
    const fuente = await cargarFuente(v);
    expect(fuente.map((c) => c.id)).toEqual(congelado.casos.map((c) => c.id));
    expect(fuente.map((c) => c.q)).toEqual(congelado.casos.map((c) => c.pregunta));
  });

  it("la referencia esta completa: cada llamada esperada trae su resultado congelado y el estado es coherente", () => {
    for (const c of congelado.casos) {
      const refs = congelado.referencias[c.id] ?? [];
      expect(refs, c.id).toHaveLength(c.esperado.llamadas.length);
      if (c.esperado.llamadas.length === 0) expect(["clarify", "out_of_catalog"], c.id).toContain(c.esperado.status);
      if (c.esperado.status === "ok") expect(c.esperado.cifras.length > 0 || c.esperado.prohibidas.length > 0, `${c.id} sin cifras`).toBe(true);
      if (c.esperado.status === "no_data") expect(c.esperado.cifras, c.id).toHaveLength(0);
    }
  });

  it("sin PII ni correos en los resultados congelados (los datos son ficticios y las herramientas solo devuelven agregados)", () => {
    const texto = JSON.stringify(congelado.referencias);
    expect(texto).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(texto).not.toMatch(/\d{10,}/);
  });

  it("el modelo guionado OROS pasa todos los graders de exactitud en los 60 casos (valida graders, fixtures y congelado)", async () => {
    const mundo = mundoRepeticion(v, congelado);
    const luna = candidatoPorId("openai/gpt-6-luna")!;
    const res = await correrEval({
      fase: "ci",
      modelos: [luna],
      casos: congelado.casos,
      mundos: { [v]: mundo },
      k: 1,
      presupuesto: new PresupuestoDuro(1),
      fabrica: (_m, caso) => scriptedCompletion(guionOro(caso, congelado)).complete,
    });
    const malos = res.registros.filter((r) => r.estado !== "evaluado" || !r.evaluacion!.ok).map((r) => `${r.casoId}: ${(r.evaluacion?.graders ?? []).filter((g) => !g.ok).map((g) => `${g.grader} ${g.detalle ?? ""}`).join(" | ") || r.estado}`);
    expect(malos).toEqual([]);
    expect(res.gastoUsd).toBe(0);
  });
});
