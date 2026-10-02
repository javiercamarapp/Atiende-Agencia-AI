import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scriptedCompletion } from "@atiende/agent-core/data-chat";
import {
  CANDIDATOS,
  HOSTS_PERMITIDOS_GATEWAY,
  JUEZ_ESPANOL_CADENA,
  PresupuestoDuro,
  candidatoPorId,
  construirReporte,
  correrEval,
  crearFabricaOpenRouter,
  crearJuezGuionado,
  crearJuezOpenRouter,
  type CasoEval,
} from "@atiende/agent-core/data-chat/evals";
import { ALLOWED_PROVIDER_HOSTS } from "../../src/production/llm-models.js";
import { VERTICALES_EVAL, mundoRepeticion } from "../../../../scripts/eval-copiloto/mundos.ts";
import { leerCongelado } from "../../../../scripts/eval-copiloto/congelado.ts";
import { cargarCasos, construirPlan, ejecutarPlan, finalistasDe, guionOro, leerLlave, parsearArgs, proyeccion, TOPE_HUMO_USD, TOPE_PILOTO_USD,
  TOPE_PILOTO_USD, TOPE_TOTAL_USD } from "../../../../scripts/eval-copiloto/ejecutar.ts";

const { casos, congelados } = cargarCasos();
const tmp = mkdtempSync(path.join(tmpdir(), "eval-copiloto-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const plan = (...a: string[]) => construirPlan(parsearArgs(a), casos);

// llave de mentira, sin forma de credencial real
const LLAVE_FALSA = "llave-falsa-de-prueba-para-el-arnes";

describe("plan de corrida (fases)", () => {
  it("hay 360 casos: 6 verticales x 60", () => {
    expect(casos).toHaveLength(360);
    expect(new Set(casos.map((c) => c.vertical))).toEqual(new Set(VERTICALES_EVAL));
  });

  it("humo: Luna, K=1, pocos casos y tope de 0.50 USD (no se puede subir)", () => {
    const p = plan("--fase=humo", "--modo=real");
    expect(p.modelos.map((m) => m.id)).toEqual(["openai/gpt-6-luna"]);
    expect(p.k).toBe(1);
    expect(p.maxUsd).toBe(TOPE_HUMO_USD);
    expect(p.casos.length).toBeLessThanOrEqual(12);
    expect(() => plan("--fase=humo", "--max-usd=2")).toThrow(/humo/);
    expect(proyeccion(p).totalUsd).toBeLessThan(0.05);
  });

  it("piloto: 30 casos por vertical (180) x K=1 con los candidatos del piloto, calibracion incluida", () => {
    const p = plan("--fase=piloto");
    expect(p.casos).toHaveLength(180);
    expect(p.k).toBe(1);
    const ids = p.modelos.map((m) => m.id);
    expect(ids).toContain("anthropic/claude-haiku-4.5");
    expect(ids).not.toContain("x-ai/grok-4.3"); // no elegible: su unico host (xai) no esta en la allowlist del gateway
    expect(ids).not.toContain("qwen/qwen3.7-flash"); // no elegible: solo Alibaba, sin ZDR
    expect(ids).not.toContain("anthropic/claude-sonnet-5.5");
    expect(ids).not.toContain("google/gemini-3.8-flash");
    expect(proyeccion(p).totalUsd).toBeLessThan(TOPE_TOTAL_USD);
  });

  it("barrido: exige finalistas, K=3, y nunca incluye calibracion ni modelos que no son de barrido", () => {
    expect(() => plan("--fase=barrido")).toThrow(/finalistas/);
    const reporte = {
      reporte: {
        resumenes: [
          { modelo: "anthropic/claude-haiku-4.5", evaluados: 180 },
          { modelo: "openai/gpt-6-luna", evaluados: 180 },
          { modelo: "deepseek/deepseek-v4.1-flash", evaluados: 180 },
          { modelo: "qwen/qwen3.7-flash", evaluados: 0 },
          { modelo: "meta/muse-spark-1.3-contributor", evaluados: 180 }, // no elegible: nunca finalista aunque traiga casos
          { modelo: "meta-llama/llama-4-maverick", evaluados: 180 },
          { modelo: "openai/gpt-5-nano", evaluados: 180 },
        ],
      },
    };
    const f = path.join(tmp, "piloto.json");
    writeFileSync(f, JSON.stringify(reporte));
    expect(finalistasDe(f, 3).map((m) => m.id)).toEqual(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"]);
    const p = plan("--fase=barrido", `--finalistas-de=${f}`, "--top=2");
    expect(p.k).toBe(3);
    expect(p.casos).toHaveLength(360);
    expect(p.modelos).toHaveLength(2);
  });

  it("el tope de gasto nunca pasa del tope total del plan (45 USD) y cfo falla honesto sin casos CFO", () => {
    expect(() => plan("--fase=piloto", "--max-usd=60")).toThrow(/entre/);
    expect(plan("--fase=piloto").maxUsd).toBe(TOPE_PILOTO_USD);
    expect(plan("--fase=piloto", "--max-usd=12").maxUsd).toBe(12);
    expect(() => plan("--fase=piloto", "--max-usd=12.5")).toThrow(/piloto no puede pasar de 12/);
    expect(() => plan("--fase=cfo")).toThrow(/no hay casos CFO/);
    expect(() => plan("--fase=piloto", "--modelos=un/modelo-inventado")).toThrow(/candidatos/);
    expect(() => plan("--fase=piloto", "--modelos=qwen/qwen3.7-flash")).toThrow(/no elegible.*Alibaba/);
    expect(() => parsearArgs(["suelto"])).toThrow();
  });

  it("la llave se lee de variable o archivo y falta es un error claro", () => {
    expect(leerLlave({ OPENROUTER_API_KEY: ` ${LLAVE_FALSA} ` })).toBe(LLAVE_FALSA);
    const f = path.join(tmp, "llave.txt");
    writeFileSync(f, `${LLAVE_FALSA}\n`);
    expect(leerLlave({ OPENROUTER_API_KEY_FILE: f })).toBe(LLAVE_FALSA);
    expect(() => leerLlave({})).toThrow(/falta la llave/);
  });
});

/** OpenRouter falso: contesta como un modelo "oro" y reporta usage.cost real por llamada. */
function openRouterFalso(costo: number, peticiones: Record<string, unknown>[] = []): typeof fetch {
  const porPregunta = new Map<string, CasoEval>();
  for (const c of casos) if (!porPregunta.has(c.pregunta)) porPregunta.set(c.pregunta, c);
  return (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content?: string }[]; model: string };
    peticiones.push(body as unknown as Record<string, unknown>);
    const user = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const caso = porPregunta.get(user)!;
    const yaHayTool = body.messages.some((m) => m.role === "tool");
    const pasos = guionOro(caso, congelados.get(caso.vertical as (typeof VERTICALES_EVAL)[number])!);
    const paso = (yaHayTool || pasos.length === 1 ? pasos[pasos.length - 1] : pasos[0]) as { text?: string; toolCalls?: { name: string; argumentsJson: string }[] };
    const message = paso.toolCalls
      ? { content: null, tool_calls: paso.toolCalls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: c.argumentsJson } })) }
      : { content: paso.text ?? "" };
    return new Response(JSON.stringify({ model: body.model, choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 80, cost: costo } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("modo real contra un OpenRouter falso (sin red, sin gasto)", () => {
  it("manda las preferencias EE.UU./ZDR de cada candidato y lee el costo REAL de usage.cost", async () => {
    const peticiones: Record<string, unknown>[] = [];
    const luna = candidatoPorId("openai/gpt-6-luna")!;
    const ds = candidatoPorId("deepseek/deepseek-v4.1-flash")!;
    const caso = congelados.get("restaurantes")!.casos[0]!;
    const fabrica = crearFabricaOpenRouter(LLAVE_FALSA, { fetchImpl: openRouterFalso(0.00042, peticiones) });
    const r = await fabrica(luna, caso, 1)({ system: "s", messages: [{ role: "user", content: caso.pregunta }] });
    expect(r.costUsd).toBeCloseTo(0.00042, 8);
    expect(r.costSource).toBe("provider");
    await fabrica(ds, caso, 1)({ system: "s", messages: [{ role: "user", content: caso.pregunta }] });
    const [pLuna, pDs] = peticiones as { provider: Record<string, unknown>; usage: unknown; temperature?: number; reasoning?: unknown }[];
    expect(pLuna!.provider).toMatchObject({ data_collection: "deny", zdr: true, require_parameters: true, allow_fallbacks: false, only: ["openai", "azure"] });
    expect(pLuna!.usage).toEqual({ include: true });
    expect(pLuna!.temperature).toBeUndefined(); // Luna rechaza temperature con require_parameters
    expect(pLuna!.reasoning).toEqual({ effort: "low" });
    expect(pDs!.provider.only).toEqual(["deepinfra", "together", "fireworks", "baseten", "parasail"]);
    expect(pDs!.temperature).toBeUndefined(); // sin temperature en la peticion de prueba (el motor la manda, aqui no)
  });

  it("ejecutarPlan (fase humo, modo real) acumula el gasto, aplica el tope y entrega reporte y markdown", async () => {
    const p = plan("--fase=humo", "--modo=real");
    const salida = await ejecutarPlan(p, congelados, { fabrica: crearFabricaOpenRouter(LLAVE_FALSA, { fetchImpl: openRouterFalso(0.0004) }), juez: crearJuezGuionado() });
    expect(salida.resultado.abortada).toBeNull();
    expect(salida.resultado.gastoUsd).toBeGreaterThan(0);
    expect(salida.resultado.gastoUsd).toBeLessThanOrEqual(TOPE_HUMO_USD);
    expect(salida.reporte.resumenes[0]!.exactitud).toBe(1);
    expect(salida.markdown).toContain("Reporte de evaluacion del Copiloto: fase humo");
  });

  it("un costo por llamada que revienta el tope aborta y reporta los casos NO corridos", async () => {
    const p = plan("--fase=humo", "--modo=real");
    const salida = await ejecutarPlan(p, congelados, { fabrica: crearFabricaOpenRouter(LLAVE_FALSA, { fetchImpl: openRouterFalso(0.2) }), juez: crearJuezGuionado(), concurrencia: 1 });
    expect(salida.resultado.abortada).toBe("tope_de_gasto");
    expect(salida.resultado.noCorridos.length).toBeGreaterThan(0);
    expect(salida.resultado.gastoUsd).toBeLessThanOrEqual(TOPE_HUMO_USD + 0.2);
    expect(salida.markdown).toContain("CORRIDA ABORTADA");
  });

  it("el juez usa Qwen3-235B por Parasail, cae a la siguiente ruta cuando una responde 404 (sin endpoint EE.UU./ZDR) y cuenta su costo", async () => {
    const rutas: string[] = [];
    const proveedores: { zdr?: boolean; data_collection?: string; only?: string[] }[] = [];
    const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body)) as { model: string; provider: { zdr?: boolean; data_collection?: string; only?: string[] } };
      rutas.push(b.model);
      proveedores.push(b.provider);
      if (rutas.length < 3) return new Response(JSON.stringify({ error: { message: "No endpoints found" } }), { status: 404 });
      return new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: '{"nota": 5, "razon": "natural"}' } }], usage: { prompt_tokens: 90, completion_tokens: 12, cost: 0.00002 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const presupuesto = new PresupuestoDuro(1);
    const juez = crearJuezOpenRouter({ apiKey: LLAVE_FALSA, presupuesto, fetchImpl });
    const n = await juez.juzgar({ pregunta: "¿Cuánto vendí ayer?", texto: "Vendiste $1,000.00 MXN en 4 pedidos." });
    expect(n.nota).toBe(5);
    expect(n.modelo).toBe(JUEZ_ESPANOL_CADENA[2]!.etiqueta);
    expect(rutas).toEqual(["qwen/qwen3-235b-a22b-2507", "qwen/qwen3-235b-a22b-2507", "deepseek/deepseek-v4.1-flash"]);
    expect(proveedores[0]).toMatchObject({ only: ["parasail"], zdr: true, data_collection: "deny" });
    // ninguna ruta del juez relaja la politica EE.UU./ZDR
    for (const p of proveedores) expect(p).toMatchObject({ zdr: true, data_collection: "deny" });
    expect(presupuesto.gastoUsd).toBeCloseTo(0.00002, 8);
    // nunca Sonnet ni Qwen 3.7 Flash (solo Alibaba, sin ZDR) como juez
    expect(JUEZ_ESPANOL_CADENA.some((r) => r.id.includes("claude") || r.id.includes("qwen3.7"))).toBe(false);
  });

  it("la lista de proveedores del arnes es la del gateway y el reporte lista los modelos no elegibles", async () => {
    expect([...HOSTS_PERMITIDOS_GATEWAY].sort()).toEqual([...ALLOWED_PROVIDER_HOSTS].sort());
    const p = plan("--fase=humo", "--modo=real");
    const salida = await ejecutarPlan(p, congelados, { fabrica: crearFabricaOpenRouter(LLAVE_FALSA, { fetchImpl: openRouterFalso(0.0004) }), juez: crearJuezGuionado() });
    expect(salida.reporte.noElegibles.map((n) => n.modelo)).toContain("qwen/qwen3.7-flash");
    expect(salida.markdown).toContain("Modelos no elegibles");
    expect(salida.markdown).toMatch(/Qwen 3\.7 Flash.*no elegible, hoy solo lo sirve Alibaba/);
  });
});

describe("el arnes distingue modelos buenos de malos (perfiles guionados sobre restaurantes)", () => {
  const congelado = leerCongelado("restaurantes");
  const luna = candidatoPorId("openai/gpt-6-luna")!;
  const correr = (perfil: (caso: CasoEval) => ReturnType<typeof guionOro>) =>
    correrEval({
      fase: "ci",
      modelos: [luna],
      casos: congelado.casos,
      mundos: { restaurantes: mundoRepeticion("restaurantes", congelado) },
      k: 1,
      presupuesto: new PresupuestoDuro(1),
      fabrica: (_m, caso) => scriptedCompletion(perfil(caso)).complete,
    });
  const resumen = (res: Awaited<ReturnType<typeof correr>>) => construirReporte(res, new Map(congelado.casos.map((c) => [c.id, { llamadas: c.esperado.llamadas.length }])), CANDIDATOS).resumenes[0]!;

  it("el inventor de cifras (llamadas correctas pero narra un total falso) no pasa la puerta de cero inventadas", async () => {
    const r = resumen(await correr((caso) => {
      const oro = guionOro(caso, congelado);
      return caso.esperado.llamadas.length > 0 ? [oro[0]!, { text: "Vendiste $987,654.32 MXN en 4321 pedidos." }] : oro;
    }));
    expect(r.herramienta).toBe(1);
    expect(r.inventadas).toBeGreaterThan(30);
    expect(r.pasaPuertas).toBe(false);
    expect(r.puertas["cero_inventadas"]).toBe(false);
    expect(r.narrativaDescartada).toBeGreaterThan(0.9);
    // aun asi las cifras exactas se ven (el motor muestra el resumen determinista): el arnes separa ambas cosas
    expect(r.cifras).toBe(1);
  });

  it("el modelo que nunca usa herramientas falla las preguntas con respuesta y solo acierta rechazos", async () => {
    const r = resumen(await correr(() => [{ text: "No lo sé." }]));
    expect(r.herramienta).toBeLessThan(0.3);
    expect(r.exactitud).toBeLessThan(0.3);
    expect(r.pasaPuertas).toBe(false);
  });

  it("el modelo que elige MAL el periodo falla periodo y argumentos pero no el JSON", async () => {
    const r = resumen(
      await correr((caso) => {
        const oro = guionOro(caso, congelado);
        if (caso.esperado.llamadas.length === 0) return oro;
        const mala = caso.esperado.llamadas.map((l) => ({ name: l.tool, argumentsJson: JSON.stringify({ ...l.args, ...(l.args["periodo"] ? { periodo: l.args["periodo"] === "ayer" ? "hoy" : "ayer" } : {}) }) }));
        return [{ toolCalls: mala }, { text: "" }];
      }),
    );
    expect(r.jsonLlamadas).toBe(1);
    expect(r.periodo).not.toBeNull();
    expect(r.periodo!).toBeLessThan(0.5);
  });
});
