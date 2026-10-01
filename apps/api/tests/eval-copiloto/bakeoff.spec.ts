import { describe, expect, it } from "vitest";
import {
  BRAZOS_BAKEOFF,
  JUEZ_ESPANOL_CADENA,
  PresupuestoDuro,
  RUBRICA_ANALISIS,
  bakeoffMarkdown,
  correrBakeoff,
  crearFabricaOpenRouter,
  crearJuezGuionado,
  crearJuezOpenRouter,
  evaluarReporte,
  extraerJson,
  juezAnalisisDesde,
  parsearReporte,
  recomendacionBakeoff,
  resumirBrazos,
  validarSvg,
  type FabricaModelo,
  type TareaBakeoff,
} from "@atiende/agent-core/data-chat/evals";
import { cargarCasos } from "../../../../scripts/eval-copiloto/ejecutar.ts";
import { fabricaOroBakeoff, proyectarBakeoffUsd, reporteOro, seleccionarTareas, TAREAS_POR_VERTICAL } from "../../../../scripts/eval-copiloto/bakeoff.ts";

const { congelados } = cargarCasos();
const tareas = seleccionarTareas(congelados);
const LLAVE_FALSA = "llave-falsa-de-prueba-para-el-arnes";

const SVG_BUENO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><title>Ventas</title><rect x="0" y="0" width="640" height="360" fill="#f8fafc"/><rect x="60" y="80" width="70" height="200" fill="#1d4ed8"/><rect x="160" y="140" width="70" height="140" fill="#1d4ed8"/><text x="60" y="300" font-size="12">Norte</text></svg>';

describe("tareas del bake-off", () => {
  it("son 40, con id unico, de las 6 verticales y construidas de tablas reales congeladas (no inventadas)", () => {
    expect(tareas).toHaveLength(40);
    expect(new Set(tareas.map((t) => t.id)).size).toBe(40);
    for (const [v, n] of Object.entries(TAREAS_POR_VERTICAL)) expect(tareas.filter((t) => t.vertical === v)).toHaveLength(n);
    for (const t of tareas) {
      expect(t.tablas.length).toBeGreaterThan(0);
      expect(t.tablas.some((x) => x.rows.length >= 2)).toBe(true);
      expect(t.peticion).toMatch(/^Prepara un reporte ejecutivo/);
    }
  });
});

describe("validarSvg", () => {
  it("acepta una infografia bien formada", () => {
    expect(validarSvg(SVG_BUENO)).toEqual({ ok: true });
  });

  it.each([
    ["script", SVG_BUENO.replace("<title>", "<script>alert(1)</script><title>")],
    ["handler", SVG_BUENO.replace("<rect x=\"60\"", "<rect onload=\"x()\" x=\"60\"")],
    ["href externo", SVG_BUENO.replace("<title>Ventas</title>", "<title>Ventas</title><a href=\"https://x.com\"><text>a</text></a>")],
    ["imagen", SVG_BUENO.replace("<title>", "<image width=\"5\" height=\"5\"/><title>")],
    ["foreignObject", SVG_BUENO.replace("<title>", "<foreignObject><div/></foreignObject><title>")],
    ["sin cerrar", SVG_BUENO.replace("</svg>", "")],
    ["cierre cruzado", SVG_BUENO.replace("</text>", "</rect>")],
    ["sin xmlns", SVG_BUENO.replace(' xmlns="http://www.w3.org/2000/svg"', "")],
    ["sin viewBox", SVG_BUENO.replace(' viewBox="0 0 640 360"', "")],
    ["NaN", SVG_BUENO.replace('width="70"', 'width="NaN"')],
    ["pocas formas", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1"/><text x="1" y="1">a</text></svg>'],
    ["sin texto", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="0" y="0" width="1" height="1"/><rect x="2" y="0" width="1" height="1"/><rect x="4" y="0" width="1" height="1"/></svg>'],
    ["doctype", `<!DOCTYPE svg>${SVG_BUENO}`],
    ["comentario", SVG_BUENO.replace("<title>", "<!-- x --><title>")],
    ["atributo sin comillas", SVG_BUENO.replace('width="70"', "width=70")],
    ["texto fuera", `${SVG_BUENO} basura`],
    ["enorme", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${'<rect x="0" y="0" width="1" height="1"/>'.repeat(200)}<text>a</text></svg>`],
    ["vacio", ""],
  ])("rechaza %s", (_n, svg) => {
    expect(validarSvg(svg).ok).toBe(false);
  });
});

describe("graders del reporte", () => {
  const tarea: TareaBakeoff = tareas[0]!;
  const bueno = reporteOro(`Peticion: x\nTablas: ${JSON.stringify(tarea.tablas.map((r, i) => ({ tabla: i, fuente: r.source, periodo: r.periodLabel ?? null, alcance: r.scopeLabel, columnas: r.columns.map((c) => ({ clave: c.key, tipo: c.kind })), filas: r.rows, resumen: r.summary ?? null })))}`) as Record<string, unknown>;
  const falla = (r: unknown, g: string): boolean => evaluarReporte(tarea, r).graders.find((x) => x.grader === g)?.ok === false;

  it("el reporte derivado de las tablas pasa todos los graders", () => {
    const e = evaluarReporte(tarea, bueno);
    expect(e.graders.filter((g) => !g.ok)).toEqual([]);
    expect(e.coberturaCifras).toBeGreaterThanOrEqual(0.6);
  });

  it("cifras inventadas, fuente inexistente, grafica sobre columnas falsas, enlace, peninsularismo y SVG con script se detectan", () => {
    expect(falla({ ...bueno, resumen: `${String(bueno["resumen"])} Ademas crecio 987654 pesos.` }, "cifras_sin_inventar")).toBe(true);
    expect(falla({ ...bueno, hallazgos: [{ texto: "x", fuente: [{ tabla: 99, fila: 0 }] }] }, "json_valido")).toBe(true);
    expect(falla({ ...bueno, hallazgos: [{ texto: "x", fuente: [{ tabla: 0, fila: 9999 }] }] }, "json_valido")).toBe(true);
    expect(falla({ ...bueno, hallazgos: [{ texto: "x", fuente: [] }] }, "json_valido")).toBe(true);
    expect(falla({ ...bueno, grafica: { kind: "bar", x: "nada", y: "tampoco", tabla: 0 } }, "json_valido")).toBe(true);
    expect(falla({ ...bueno, resumen: `${String(bueno["resumen"])} Mira https://x.com` }, "espanol_reglas")).toBe(true);
    expect(falla({ ...bueno, resumen: `${String(bueno["resumen"])} Usa el ordenador.` }, "espanol_reglas")).toBe(true);
    expect(falla({ ...bueno, svg: String(bueno["svg"]).replace("<title>", "<script>x</script><title>") }, "svg_valido")).toBe(true);
    expect(evaluarReporte(tarea, null).ok).toBe(false);
    expect(parsearReporte("texto", tarea.tablas).ok).toBe(false);
  });

  it("una cobertura baja de cifras clave falla la puerta aunque nada este inventado", () => {
    const sinCifras = { ...bueno, resumen: "Todo va bien.", secciones: [{ encabezado: "Resumen", texto: "Sin cifras." }], hallazgos: [{ texto: "Sin cifras.", fuente: [{ tabla: 0, fila: 0 }] }] };
    const e = evaluarReporte(tarea, sinCifras);
    expect(e.graders.find((g) => g.grader === "cifras_clave")?.ok).toBe(false);
    expect(e.graders.find((g) => g.grader === "cifras_sin_inventar")?.ok).toBe(true);
  });

  it("extraerJson tolera cercas de codigo y texto alrededor", () => {
    expect(extraerJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extraerJson('Claro: {"a":{"b":2}} listo')).toEqual({ a: { b: 2 } });
    expect(() => extraerJson("sin json")).toThrow();
  });
});

describe("runner del bake-off", () => {
  it("modelo oro: los 4 brazos pasan las puertas en las 40 tareas y la recomendacion elige el mas barato", async () => {
    const res = await correrBakeoff({ tareas, brazos: BRAZOS_BAKEOFF, presupuesto: new PresupuestoDuro(1), fabrica: fabricaOroBakeoff(), juez: juezAnalisisDesde(crearJuezGuionado(() => 5)) });
    expect(res.registros).toHaveLength(160);
    expect(res.abortada).toBeNull();
    const rs = resumirBrazos(res);
    expect(rs.every((r) => r.pasaPuertas && r.inventadas === 0)).toBe(true);
    expect(recomendacionBakeoff(rs)).toMatch(/mas barato/);
    expect(bakeoffMarkdown(res)).toContain("Bake-off de reportes");
  });

  it("OpenRouter falso: suma el costo REAL de las dos etapas del pipeline y de la etapa unica, con las preferencias EE.UU./ZDR", async () => {
    const peticiones: { model: string; provider: Record<string, unknown> }[] = [];
    const oro = fabricaOroBakeoff();
    const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[]; provider: Record<string, unknown> };
      peticiones.push({ model: b.model, provider: b.provider });
      const system = b.messages[0]!.content;
      const r = await oro({ id: b.model })({ system, messages: b.messages.filter((m) => m.role !== "system") as never });
      const cost = b.model.includes("sonnet") ? 0.01 : 0.002;
      return new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: r.text } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost } }), { status: 200 });
    }) as unknown as typeof fetch;
    const f = crearFabricaOpenRouter(LLAVE_FALSA, { fetchImpl });
    const fabrica: FabricaModelo = (m) => f(m, undefined as never, 1);
    const presupuesto = new PresupuestoDuro(5);
    const res = await correrBakeoff({ tareas: tareas.slice(0, 2), brazos: BRAZOS_BAKEOFF, presupuesto, fabrica });
    const porBrazo = (id: string) => res.registros.filter((r) => r.brazo === id).map((r) => r.costoUsd);
    expect(porBrazo("pipeline_gemini")).toEqual([0.012, 0.012]);
    expect(porBrazo("pipeline_qwen")).toEqual([0.012, 0.012]);
    expect(porBrazo("sonnet_solo")).toEqual([0.01, 0.01]);
    expect(porBrazo("gemini_solo")).toEqual([0.002, 0.002]);
    expect(presupuesto.gastoUsd).toBeCloseTo(2 * (0.012 + 0.012 + 0.01 + 0.002), 6);
    const sonnet = peticiones.find((p) => p.model === "anthropic/claude-sonnet-5.5")!;
    expect(sonnet.provider).toMatchObject({ data_collection: "deny", zdr: true, require_parameters: true, only: ["anthropic", "google-vertex", "amazon-bedrock"] });
    const gem = peticiones.find((p) => p.model === "google/gemini-3.8-flash")!;
    expect(gem.provider).toMatchObject({ only: ["google-ai-studio", "google-vertex"] });
  });

  it("el tope de gasto aborta y lista los reportes no corridos", async () => {
    const oro = fabricaOroBakeoff();
    const fabrica: FabricaModelo = (m) => async (req) => ({ ...(await oro(m)(req)), costUsd: 0.3 });
    const res = await correrBakeoff({ tareas: tareas.slice(0, 5), brazos: BRAZOS_BAKEOFF.slice(2), presupuesto: new PresupuestoDuro(0.5, 0.05), fabrica });
    expect(res.abortada).toBe("tope_de_gasto");
    expect(res.noCorridos.length).toBeGreaterThan(0);
    expect(bakeoffMarkdown(res)).toContain("CORRIDA ABORTADA");
  });

  it("el juez de analisis usa la cadena barata (Qwen3-235B por Parasail, luego las demas rutas EE.UU./ZDR) con la rubrica de analisis y jamas Sonnet", async () => {
    const cuerpos: { model: string; system: string }[] = [];
    const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[] };
      cuerpos.push({ model: b.model, system: b.messages[0]!.content });
      return new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: '{"nota": 4, "razon": "solido"}' } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.00001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const presupuesto = new PresupuestoDuro(1);
    const juez = juezAnalisisDesde(crearJuezOpenRouter({ apiKey: LLAVE_FALSA, presupuesto, fetchImpl, rubrica: RUBRICA_ANALISIS }));
    const r = await juez.calificar({ peticion: "p", tablasJson: "[]", reporte: "{}" });
    expect(r.nota).toBe(4);
    expect(cuerpos[0]!.model).toBe("qwen/qwen3-235b-a22b-2507");
    expect(cuerpos[0]!.system).toBe(RUBRICA_ANALISIS);
    expect(JUEZ_ESPANOL_CADENA.every((x) => !x.id.includes("claude"))).toBe(true);
  });

  it("proyeccion: orden de magnitud del bake-off completo (4 brazos x 40 reportes) bajo el tope total", () => {
    const usd = proyectarBakeoffUsd(40, BRAZOS_BAKEOFF);
    expect(usd).toBeGreaterThan(2);
    expect(usd).toBeLessThan(8);
  });
});
