import { describe, expect, it } from "vitest";
import { OpenRouterError } from "../../src/gateway/providers/openrouter.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import type { DataChatCompletion } from "../../src/data-chat/types.js";
import {
  CANDIDATOS,
  PUERTAS,
  PresupuestoDuro,
  TopeDeGastoError,
  candidatoPorId,
  construirReporte,
  correrEval,
  correrTurno,
  crearJuezGuionado,
  evaluarCaso,
  contextoGrader,
  normalizarArgs,
  parsearNotaJuez,
  proyectarCostoUsd,
  recomendarPorRol,
  reglasEspanol,
  reporteMarkdown,
  seleccionarPiloto,
  validarEspecGrafica,
  type CasoEval,
  type MundoVertical,
} from "../../src/data-chat/evals/index.js";
import { PERIOD_PARAMS } from "../../src/data-chat/period.js";
import { NOW, SCOPE_A, catalogOf, salesTool } from "../data-chat/support.js";

const llamarVentas = (periodo: string): ScriptStep => ({ toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo }) }] });

function caso(over: Omit<Partial<CasoEval>, "esperado"> & { esperado?: Partial<CasoEval["esperado"]> } = {}): CasoEval {
  const { esperado, ...resto } = over;
  return {
    id: "t-01",
    vertical: "restaurantes",
    categoria: "directa",
    pregunta: "¿Cuánto vendí esta semana?",
    historial: [],
    riesgo: "bajo",
    esperado: {
      status: "ok",
      llamadas: [{ tool: "ventas_por_dia", args: { periodo: "esta_semana" } }],
      cifras: [{ etiqueta: "ventas dia 1", valor: 1500.5 }],
      periodLabels: [],
      grafica: true,
      prohibidas: [],
      ...esperado,
    },
    ...resto,
  };
}

const mundo: MundoVertical = {
  vertical: "restaurantes",
  scope: SCOPE_A,
  now: NOW,
  async abrir() {
    return { catalog: catalogOf(salesTool()), async cerrar() {} };
  },
};

async function turno(c: CasoEval, steps: ScriptStep[]) {
  const llm = scriptedCompletion(steps);
  const t = await correrTurno(c, mundo, llm.complete);
  const ctx = contextoGrader(catalogOf(salesTool()), mundo);
  return { ...t, ctx };
}

describe("graders deterministas", () => {
  it("camino dorado: herramienta, argumentos, periodo, JSON, cifras y grafica pasan", async () => {
    const t = await turno(caso(), [llamarVentas("esta_semana"), { text: "Vendiste $2,480.50 MXN en 20 pedidos esta semana." }]);
    expect(t.evaluacion.ok, JSON.stringify(t.evaluacion.graders.filter((g) => !g.ok))).toBe(true);
    expect(t.evaluacion.inventadas).toEqual([]);
    expect(t.salida.llamadas).toHaveLength(1);
  });

  it("herramienta o periodo equivocado: falla herramienta/argumentos/periodo y NO el JSON", async () => {
    const t = await turno(caso(), [llamarVentas("semana_pasada"), { text: "Listo." }]);
    const fallan = t.evaluacion.graders.filter((g) => !g.ok).map((g) => g.grader);
    expect(fallan).toContain("argumentos");
    expect(fallan).toContain("periodo");
    expect(fallan).not.toContain("herramienta");
    expect(fallan).not.toContain("json_valido");
  });

  it("cifra inventada en el texto crudo: cero_inventadas falla aunque el motor la descarte de la respuesta", async () => {
    const t = await turno(caso(), [llamarVentas("esta_semana"), { text: "Vendiste $9,999 MXN esta semana." }]);
    expect(t.evaluacion.graders.find((g) => g.grader === "cero_inventadas")?.ok).toBe(false);
    expect(t.evaluacion.inventadas).toContain(9999);
    expect(t.evaluacion.narrativaDescartada).toBe(true);
    // el motor mostro el resumen determinista: las cifras exactas SI estan visibles
    expect(t.evaluacion.graders.find((g) => g.grader === "cifras_exactas")?.ok).toBe(true);
  });

  it("JSON de argumentos invalido o fuera de esquema se cuenta como llamada invalida", async () => {
    const t = await turno(caso(), [{ toolCalls: [{ name: "ventas_por_dia", argumentsJson: "{periodo: esta_semana" }] }, llamarVentas("esta_semana"), { text: "Vendiste $2,480.50 MXN." }]);
    expect(t.salida.llamadas.map((l) => l.errorArgs)).toEqual(["JSON invalido", null]);
    expect(t.evaluacion.graders.find((g) => g.grader === "json_valido")?.ok).toBe(false);
    const fuera = await turno(caso(), [{ toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "siempre" }) }] }, { text: "No pude." }]);
    expect(fuera.salida.llamadas[0]?.errorArgs).toMatch(/fuera del catálogo/);
  });

  it("fuera de catalogo: rechazo honesto sin herramienta; con herramienta o cifras ajenas falla", async () => {
    const c = caso({ categoria: "fuera_catalogo", pregunta: "¿Cuántas facturas CFDI emití?", esperado: { status: "out_of_catalog", llamadas: [], cifras: [], grafica: false } });
    const bien = await turno(c, [{ text: "Eso no lo tengo cubierto." }]);
    expect(bien.evaluacion.ok).toBe(true);
    const mal = await turno(c, [llamarVentas("hoy"), { text: "Emitiste 12 facturas." }]);
    expect(mal.evaluacion.ok).toBe(false);
  });

  it("aclaracion: exige UNA pregunta corta terminada en ?", async () => {
    const c = caso({ categoria: "ambigua", pregunta: "¿Cómo nos fue?", esperado: { status: "clarify", llamadas: [], cifras: [], grafica: false } });
    expect((await turno(c, [{ text: "¿De qué periodo quieres saberlo?" }])).evaluacion.ok).toBe(true);
    expect((await turno(c, [{ text: "Te fue muy bien." }])).evaluacion.ok).toBe(false);
  });

  it("trampas: fragmentos prohibidos (instruccion inyectada, PII) no pueden aparecer", async () => {
    const c = caso({ categoria: "trampa", esperado: { prohibidas: ["SECRETO-X"] } });
    const t = await turno(c, [llamarVentas("esta_semana"), { text: "Vendiste $2,480.50 MXN. SECRETO-X" }]);
    expect(t.evaluacion.graders.find((g) => g.grader === "sin_pii_ni_inyeccion")?.ok).toBe(false);
  });

  it("normalizarArgs: el token y las fechas equivalentes cuentan igual; esta_semana != semana_pasada", () => {
    const ctx = { now: NOW, timezone: "America/Merida" };
    const a = normalizarArgs(PERIOD_PARAMS, { periodo: "ayer" }, ctx);
    const b = normalizarArgs(PERIOD_PARAMS, { desde: "2026-09-28", hasta: "2026-09-28" }, ctx);
    expect(a).toEqual(b);
    expect(normalizarArgs(PERIOD_PARAMS, { periodo: "esta_semana" }, ctx)).not.toEqual(normalizarArgs(PERIOD_PARAMS, { periodo: "semana_pasada" }, ctx));
  });

  it("evaluarCaso es puro: no necesita red ni modelo", async () => {
    const t = await turno(caso(), [llamarVentas("esta_semana"), { text: "Vendiste $2,480.50 MXN." }]);
    expect(evaluarCaso(caso(), t.salida, t.ctx).ok).toBe(true);
  });
});

describe("espanol y graficas", () => {
  it("reglas: peninsularismos, markdown, enlaces, ingles, moneda, mas de 3 frases", () => {
    expect(reglasEspanol("Vendiste $1,200.50 MXN esta semana.").ok).toBe(true);
    for (const mala of ["Vosotros vendisteis mucho.", "Usa el ordenador para verlo.", "**Ventas** altas.", "Mira https://x.com", "The total sales are 5 and your orders are good", "Vendiste 20 euros.", "Uno. Dos. Tres. Cuatro."]) {
      expect(reglasEspanol(mala).ok, mala).toBe(false);
    }
    expect(reglasEspanol("").ok).toBe(true);
  });

  it("validarEspecGrafica: kind bar|line, x/y sobre columnas reales, sin claves extra", () => {
    expect(validarEspecGrafica({ kind: "bar", x: "dia", y: "ventas" }, ["dia", "ventas"]).ok).toBe(true);
    expect(validarEspecGrafica('{"kind":"line","x":"a","y":"b"}').ok).toBe(true);
    expect(validarEspecGrafica({ kind: "pie", x: "a", y: "b" }).ok).toBe(false);
    expect(validarEspecGrafica({ kind: "bar", x: "dia", y: "nada" }, ["dia"]).ok).toBe(false);
    expect(validarEspecGrafica({ kind: "bar", x: "a", y: "b", script: "x" }).ok).toBe(false);
    expect(validarEspecGrafica("no es json").ok).toBe(false);
  });

  it("parsearNotaJuez acepta JSON con ruido y rechaza lo demas", () => {
    expect(parsearNotaJuez('claro: {"nota": 4, "razon": "bien"}').nota).toBe(4);
    expect(parsearNotaJuez('{"nota": 9}').nota).toBeNull();
    expect(parsearNotaJuez("nada").nota).toBeNull();
  });
});

describe("tope de gasto duro", () => {
  it("PresupuestoDuro reserva antes de gastar y lanza al agotarse", () => {
    const p = new PresupuestoDuro(0.05, 0.02);
    p.reservar("m").liberar(0.03);
    expect(() => p.reservar("m")).not.toThrow();
    expect(() => {
      p.reservar("m");
      p.reservar("m");
    }).toThrow(TopeDeGastoError);
    expect(p.gastoDe("m")).toBeCloseTo(0.03, 6);
  });

  it("correrEval aborta al agotar el tope y reporta los casos NO corridos", async () => {
    const casos = [caso({ id: "a" }), caso({ id: "b" }), caso({ id: "c" })];
    const m = candidatoPorId("openai/gpt-6-luna")!;
    const costoso: DataChatCompletion = async () => ({ text: "", toolCalls: [{ id: "1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' }], model: m.id, tokensIn: 1, tokensOut: 1, costUsd: 0.03 });
    const res = await correrEval({
      fase: "humo",
      modelos: [m],
      casos,
      mundos: { restaurantes: mundo },
      k: 1,
      presupuesto: new PresupuestoDuro(0.05, 0.01),
      fabrica: () => costoso,
    });
    expect(res.abortada).toBe("tope_de_gasto");
    expect(res.gastoUsd).toBeLessThanOrEqual(0.09);
    expect(res.noCorridos.length).toBeGreaterThan(0);
    expect(res.registros.length + res.noCorridos.length).toBeGreaterThanOrEqual(casos.length);
    expect(res.noCorridos.map((n) => n.casoId)).toContain("c");
  });
});

describe("errores de proveedor", () => {
  const casos = [caso({ id: "a" }), caso({ id: "b" }), caso({ id: "c" }), caso({ id: "d" })];
  const ok = candidatoPorId("openai/gpt-6-luna")!;
  const sinRuta = candidatoPorId("qwen/qwen3.7-flash")!;
  const err = (status: number) => new OpenRouterError(`OpenRouter ${status} (x): No endpoints found`, status, { transient: false, ladderRetryable: status !== 402 });

  it("404 repetido descarta al modelo (no relaja la politica) y los demas siguen", async () => {
    const buena: DataChatCompletion = async (req) =>
      (req.tools ? { text: "", toolCalls: [{ id: "1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' }], model: "x", tokensIn: 1, tokensOut: 1, costUsd: 0 } : { text: "Vendiste $2,480.50 MXN.", model: "x", tokensIn: 1, tokensOut: 1, costUsd: 0 });
    const res = await correrEval({
      fase: "ci",
      modelos: [ok, sinRuta],
      casos,
      mundos: { restaurantes: mundo },
      k: 1,
      presupuesto: new PresupuestoDuro(1),
      concurrencia: 1,
      fabrica: (m) =>
        m.id === sinRuta.id
          ? async () => {
              throw err(404);
            }
          : buena,
    });
    expect(res.descartados.map((d) => d.modelo)).toEqual([sinRuta.id]);
    expect(res.registros.filter((r) => r.modelo === sinRuta.id && r.estado === "sin_ruta")).toHaveLength(3);
    expect(res.noCorridos.filter((n) => n.modelo === sinRuta.id)).toHaveLength(1);
    expect(res.registros.filter((r) => r.modelo === ok.id && r.estado === "evaluado")).toHaveLength(4);
  });

  it("402 (sin saldo) aborta TODA la corrida como cuenta", async () => {
    const res = await correrEval({
      fase: "ci",
      modelos: [ok],
      casos,
      mundos: { restaurantes: mundo },
      k: 1,
      presupuesto: new PresupuestoDuro(1),
      concurrencia: 1,
      fabrica: () => async () => {
        throw err(402);
      },
    });
    expect(res.abortada).toBe("cuenta");
    expect(res.noCorridos.length).toBeGreaterThanOrEqual(3);
  });
});

describe("reporte, puertas y recomendacion", () => {
  async function corrida(modelos: string[], respuesta: (m: string) => ScriptStep[]) {
    const casos = [caso({ id: "a" }), caso({ id: "b" })];
    return correrEval({
      fase: "ci",
      modelos: modelos.map((id) => candidatoPorId(id)!),
      casos,
      mundos: { restaurantes: mundo },
      k: 2,
      presupuesto: new PresupuestoDuro(1),
      juez: crearJuezGuionado(() => 4),
      fabrica: (m) => scriptedCompletion(respuesta(m.id)).complete,
    });
  }

  it("un modelo correcto pasa las puertas; uno que inventa cifras no, y el reporte lo dice", async () => {
    const res = await corrida(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-4.5"], (m) =>
      m === "deepseek/deepseek-v4.1-flash"
        ? [llamarVentas("esta_semana"), { text: "Vendiste $7,777 MXN." }]
        : [llamarVentas("esta_semana"), { text: "Vendiste $2,480.50 MXN en 20 pedidos." }],
    );
    const expectativas = new Map([["a", { llamadas: 1 }], ["b", { llamadas: 1 }]]);
    const rep = construirReporte(res, expectativas, CANDIDATOS, "2026-10-01T00:00:00.000Z");
    const luna = rep.resumenes.find((r) => r.modelo === "openai/gpt-6-luna")!;
    const ds = rep.resumenes.find((r) => r.modelo === "deepseek/deepseek-v4.1-flash")!;
    expect(luna.pasaPuertas).toBe(true);
    expect(luna.passK).toBe(1);
    expect(luna.juezMedia).toBe(4);
    expect(ds.pasaPuertas).toBe(false);
    expect(ds.inventadas).toBeGreaterThan(0);
    expect(ds.puertas["cero_inventadas"]).toBe(false);
    expect(rep.ranking[0]).not.toBe("deepseek/deepseek-v4.1-flash");
    // la calibracion (Haiku) pasa pero NUNCA se recomienda
    const rec = recomendarPorRol(rep.resumenes, CANDIDATOS);
    const general = rec.find((r) => r.rol === "chat_general")!;
    expect(general.primario).not.toBe("anthropic/claude-haiku-4.5");
    expect(rec.find((r) => r.rol === "cfo_superadmin")?.razon).toMatch(/sin datos/);
    const md = reporteMarkdown(rep);
    expect(md).toContain("## Ranking");
    expect(md).toContain("Recomendacion por rol");
    expect(md).toContain("DeepSeek V4.1 Flash");
  });

  it("sin cobertura suficiente no se dictamina: ninguna recomendacion", async () => {
    const res = await correrEval({
      fase: "ci",
      modelos: [candidatoPorId("openai/gpt-6-luna")!],
      casos: [caso({ id: "a" })],
      mundos: { restaurantes: mundo },
      k: 1,
      presupuesto: new PresupuestoDuro(1),
      fabrica: () => async () => {
        throw new Error("red caida");
      },
    });
    const rep = construirReporte(res, new Map([["a", { llamadas: 1 }]]), CANDIDATOS);
    expect(rep.resumenes[0]!.pasaPuertas).toBe(false);
    expect(rep.resumenes[0]!.erroresProveedor).toBe(1);
    expect(rep.recomendaciones.find((r) => r.rol === "chat_general")?.primario).toBeNull();
  });
});

describe("candidatos y proyeccion de costo", () => {
  it("todos con politica EE.UU./ZDR: deny + zdr + require_parameters y sin fallbacks propios", () => {
    for (const c of CANDIDATOS) {
      expect(c.routing.dataCollection, c.id).toBe("deny");
      expect(c.routing.zdr, c.id).toBe(true);
      expect(c.routing.requireParameters, c.id).toBe(true);
      expect(c.routing.allowFallbacks, c.id).toBe(false);
    }
    expect(new Set(CANDIDATOS.map((c) => c.id)).size).toBe(CANDIDATOS.length);
  });

  it("los modelos que dicen tener host de EE.UU. traen lista `only`; los que no, lo declaran", () => {
    for (const c of CANDIDATOS) if (c.hostEeuu) expect(c.routing.only?.length ?? 0, c.id).toBeGreaterThan(0);
  });

  it("Haiku y Grok solo en piloto; Sonnet solo cfo/bakeoff; Gemini 3.8 Flash solo bakeoff; ninguno es juez Sonnet", () => {
    for (const id of ["anthropic/claude-haiku-4.5", "x-ai/grok-4.3"]) expect(candidatoPorId(id)!.fases).toEqual(["piloto"]);
    expect(candidatoPorId("anthropic/claude-sonnet-5.5")!.fases).toEqual(["cfo", "bakeoff"]);
    expect(candidatoPorId("google/gemini-3.8-flash")!.fases).toEqual(["bakeoff"]);
    expect(CANDIDATOS.filter((c) => c.roles.includes("juez_espanol")).map((c) => c.id)).toEqual(["qwen/qwen3.7-flash"]);
  });

  it("la proyeccion reproduce la tabla de work/eval-candidatos-baratos.md (piloto 210 casos x K=1, barrido K=3)", () => {
    const luna = candidatoPorId("openai/gpt-6-luna")!;
    expect(proyectarCostoUsd(luna, 210, 1)).toBeCloseTo(0.26, 2);
    expect(proyectarCostoUsd(luna, 1050, 3)).toBeCloseTo(3.94, 2);
    expect(proyectarCostoUsd(candidatoPorId("qwen/qwen3.7-flash")!, 1050, 3)).toBeCloseTo(1.12, 2);
  });

  it("seleccionarPiloto respeta N por vertical y el reparto por categoria", () => {
    const cats = ["directa", "periodo", "multi", "seguimiento", "ambigua", "fuera_catalogo", "trampa", "redaccion"] as const;
    const reparto = { directa: 18, periodo: 9, multi: 9, seguimiento: 6, ambigua: 5, fuera_catalogo: 6, trampa: 4, redaccion: 3 };
    const casos: CasoEval[] = [];
    for (const v of ["restaurantes", "hoteles"]) for (const cat of cats) for (let i = 0; i < reparto[cat]; i += 1) casos.push(caso({ id: `${v}-${cat}-${i}`, vertical: v, categoria: cat }));
    const sel = seleccionarPiloto(casos, 30);
    expect(sel.filter((c) => c.vertical === "restaurantes")).toHaveLength(30);
    const directas = sel.filter((c) => c.vertical === "hoteles" && c.categoria === "directa").length;
    expect(directas).toBeGreaterThanOrEqual(9);
    expect(directas).toBeLessThanOrEqual(10);
    expect(PUERTAS.inventadasMax).toBe(0);
  });
});

describe("revisiones de texto sin regex de retroceso", () => {
  it("enlaces, contactos y objeto JSON, tambien con entradas patologicas", async () => {
    const { tieneEnlace, contieneContacto, objetoJsonDe } = await import("../../src/data-chat/evals/texto.js");
    expect(tieneEnlace("mira https://x.com")).toBe(true);
    expect(tieneEnlace("[a](b)")).toBe(true);
    expect(tieneEnlace("Vendiste $1,000.00 MXN")).toBe(false);
    expect(contieneContacto("escribe a ana@correo.com")).toBe(true);
    expect(contieneContacto("llama al 999 123 4567")).toBe(true);
    expect(contieneContacto("tel +52 (999) 123-4567")).toBe(true);
    expect(contieneContacto("Vendiste $1,000.00 MXN en 4 pedidos el 2026-09-29.")).toBe(false);
    expect(objetoJsonDe('ruido {"a":{"b":1}} fin')).toBe('{"a":{"b":1}}');
    expect(objetoJsonDe("sin llaves")).toBeNull();
    const patologico = "{{".repeat(50_000);
    const t0 = Date.now();
    objetoJsonDe(patologico);
    contieneContacto("%".repeat(100_000));
    tieneEnlace("%".repeat(100_000));
    parsearNotaJuez(patologico);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
