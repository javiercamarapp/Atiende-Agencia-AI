// CHAT-05: motor de modelos baratos. Limites por turno (rondas, tokens, filas, historial, tiempos), cascada acotada a UNA
// llamada escalada y medicion de uso, todo con `scriptedCompletion` (sin red ni gasto).
import { describe, expect, it } from "vitest";
import { runDataChatTurn, type RunDataChatTurnOptions } from "../../src/data-chat/engine.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import { DEFAULT_DATA_CHAT_LIMITS, type DataChatUsage } from "../../src/data-chat/types.js";
import type { LlmCompletionResult } from "../../src/gateway/types.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

const CALL: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) }] };
const DETERMINISTA = "Ventas del periodo: $2,480.50 MXN en 20 pedidos.";
const BUENA = "Vendiste $2,480.50 MXN en 20 pedidos.";
const INVENTADA = "Vendiste $99,000 MXN.";

function turn(steps: ScriptStep[], over: Partial<RunDataChatTurnOptions> = {}, tool = salesTool()) {
  const llm = scriptedCompletion(steps);
  const usos: DataChatUsage[] = [];
  const run = () =>
    runDataChatTurn({
      catalog: catalogOf(tool),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      complete: llm.complete,
      audit: new MemoryAudit(),
      now: NOW,
      onUso: (u) => usos.push(u),
      ...over,
    });
  return { llm, usos, run };
}

describe("limites por turno (spec g.3)", () => {
  it("los defaults son los del plan: 2 rondas de LLM, 3 consultas, 150/350 tokens, 20 filas al modelo, 4 turnos de historial", () => {
    expect(DEFAULT_DATA_CHAT_LIMITS).toMatchObject({
      maxToolRounds: 1,
      maxToolCallsPerTurn: 3,
      maxRepairRounds: 1,
      maxRows: 50,
      maxModelRows: 20,
      maxOutputTokensChoose: 150,
      maxOutputTokensWrite: 350,
      maxHistoryTurns: 4,
      maxToolDescriptionChars: 160,
      llmCallTimeoutMs: 20_000,
      turnTimeoutMs: 45_000,
    });
  });

  it("un turno usa como maximo DOS llamadas al modelo (elegir y redactar) aunque el modelo siga pidiendo herramientas", async () => {
    const t = turn([CALL]); // el guion repite la misma llamada para siempre
    const a = await t.run();
    expect(t.llm.requests).toHaveLength(2);
    expect(t.llm.requests[0]!.tools).toBeDefined();
    expect(t.llm.requests[1]!.tools).toBeUndefined(); // la redaccion no ofrece herramientas
    expect(a.status).toBe("ok");
    expect(a.text).toBe(DETERMINISTA); // narrativa vacia -> resumen determinista
  });

  it("si ninguna consulta se ejecuto (argumentos invalidos), hay UNA ronda extra para corregirse; con resultados nunca se usa", async () => {
    const mala: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "hoy", organization_id: "x" }) }] };
    const t = turn([mala, CALL, { text: BUENA }]);
    const a = await t.run();
    expect(t.llm.requests).toHaveLength(3); // mala, corregida, redaccion
    expect(t.llm.requests.map((r) => r.tools !== undefined)).toEqual([true, true, false]);
    expect(a.text).toBe(BUENA);
    // y solo UNA: si vuelve a fallar, se rinde
    const t2 = turn([mala]);
    const a2 = await t2.run();
    expect(t2.llm.requests).toHaveLength(3);
    expect(a2.status).toBe("out_of_catalog");
    // con maxRepairRounds 0 no hay ronda extra
    const t3 = turn([mala], { limits: { maxRepairRounds: 0 } });
    await t3.run();
    expect(t3.llm.requests).toHaveLength(2);
  });

  it("tokens de salida: 150 al elegir herramienta y 350 al redactar", async () => {
    const t = turn([CALL, { text: BUENA }]);
    await t.run();
    expect(t.llm.requests.map((r) => r.maxOutputTokens)).toEqual([150, 350]);
  });

  it("el techo general maxOutputTokens sigue mandando si es menor", async () => {
    const t = turn([CALL, { text: BUENA }], { limits: { maxOutputTokens: 100 } });
    await t.run();
    expect(t.llm.requests.map((r) => r.maxOutputTokens)).toEqual([100, 100]);
  });

  it("la descripcion de cada herramienta se recorta a 160 caracteres para el modelo (el catalogo conserva la completa)", async () => {
    const largo = salesTool();
    const tool = { ...largo, description: "Ventas por día. ".repeat(40) };
    const t = turn([{ text: "¿De qué periodo?" }], {}, tool);
    await t.run();
    expect(t.llm.requests[0]!.tools![0]!.description.length).toBeLessThanOrEqual(160);
    expect(tool.description.length).toBeGreaterThan(160);
  });

  it("al modelo le llegan 20 filas por herramienta con aviso de recorte; la tabla de la UI conserva las 40", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ dia: `d${i}`, ventas: i, pedidos: 1 }));
    const t = turn([CALL, { text: "Revisé las ventas." }], {}, salesTool({ rows }));
    const a = await t.run();
    const toolMsg = t.llm.requests[1]!.messages.find((m) => m.role === "tool") as { content: string };
    const payload = JSON.parse(toolMsg.content) as { filas: unknown[]; filasMostradas?: number; filasTotales?: number; nota?: string };
    expect(payload.filas).toHaveLength(20);
    expect(payload.filasMostradas).toBe(20);
    expect(payload.filasTotales).toBe(40);
    expect(payload.nota).toMatch(/no calcules totales/);
    expect(a.blocks[0]!.rows).toHaveLength(40);
  });

  it("sin recorte no se agregan los campos de aviso", async () => {
    const t = turn([CALL, { text: BUENA }]);
    await t.run();
    const payload = JSON.parse((t.llm.requests[1]!.messages.find((m) => m.role === "tool") as { content: string }).content) as Record<string, unknown>;
    expect(payload.filasMostradas).toBeUndefined();
    expect(payload.filasTotales).toBeUndefined();
  });

  it("historial: solo los ultimos 4 turnos y las respuestas viejas del asistente se resumen a su primera frase", async () => {
    const history = [
      { role: "user" as const, text: "pregunta 1" },
      { role: "assistant" as const, text: "Vendiste $1,000 MXN. Y además hubo 12 pedidos con muchos detalles que ya no hacen falta." },
      { role: "user" as const, text: "pregunta 2" },
      { role: "assistant" as const, text: "Hubo 12 pedidos el lunes. Detalle largo." },
      { role: "user" as const, text: "pregunta 3" },
    ];
    const t = turn([{ text: "¿De qué periodo?" }], { history });
    await t.run();
    const msgs = t.llm.requests[0]!.messages;
    expect(msgs).toHaveLength(5); // 4 de historial + la pregunta
    expect(msgs[0]).toMatchObject({ role: "assistant", content: "Vendiste $1,000 MXN." });
    expect(msgs[1]).toMatchObject({ role: "user", content: "pregunta 2" });
    expect(msgs[2]).toMatchObject({ role: "assistant", content: "Hubo 12 pedidos el lunes." });
    expect(msgs[3]).toMatchObject({ role: "user", content: "pregunta 3" });
    expect(msgs[4]).toMatchObject({ role: "user", content: "¿Cuánto vendí esta semana?" });
  });

  it("historial: el resumen de la primera frase no deja pasar mas de 200 caracteres", async () => {
    const t = turn([{ text: "¿De qué periodo?" }], { history: [{ role: "assistant", text: "x".repeat(500) }] });
    await t.run();
    expect(t.llm.requests[0]!.messages[0]!.content.length).toBeLessThanOrEqual(200);
  });
});

describe("tiempos del turno", () => {
  const colgada = () => new Promise<LlmCompletionResult>(() => {});

  it("una llamada al modelo que no responde en llmCallTimeoutMs, ANTES de tener resultados, cae al modo sin IA", async () => {
    const errores: string[] = [];
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      complete: colgada,
      now: NOW,
      limits: { llmCallTimeoutMs: 30 },
      onError: (w) => errores.push(w),
    });
    expect(a.status).toBe("unavailable");
    expect(a.noAi?.reason).toBe("provider_down");
    expect(errores).toContain("llm");
  });

  it("si el modelo se cuelga al REDACTAR, los resultados no se pierden: respuesta con las cifras deterministas", async () => {
    const llm = scriptedCompletion([CALL]);
    let n = 0;
    const errores: string[] = [];
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      complete: (req) => (++n === 1 ? llm.complete(req) : colgada()),
      now: NOW,
      limits: { llmCallTimeoutMs: 30 },
      onError: (w) => errores.push(w),
    });
    expect(a.status).toBe("ok");
    expect(a.text).toBe(DETERMINISTA);
    expect(a.blocks).toHaveLength(1);
    expect(errores).toContain("llm_timeout");
  });

  it("pasado turnTimeoutMs tras las herramientas ya no se llama al modelo: cifras deterministas", async () => {
    const lenta = salesTool({
      run: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { status: "ok", source: "Pedidos", scopeLabel: "todas", columns: [{ key: "ventas", label: "Ventas", kind: "mxn" }], rows: [{ ventas: 1 }], summary: DETERMINISTA };
      },
    });
    const t = turn([CALL, { text: BUENA }], { limits: { turnTimeoutMs: 5 } }, lenta);
    const a = await t.run();
    expect(t.llm.requests).toHaveLength(1); // solo la de elegir herramienta
    expect(a.status).toBe("ok");
    expect(a.text).toBe(DETERMINISTA);
  });
});

describe("cascada: SOLO si falla la guardia de cifras, exactamente UNA llamada escalada y luego determinista", () => {
  it("narrativa buena del modelo barato: no hay llamada escalada (ruta barato)", async () => {
    const retry = scriptedCompletion([{ text: "no debe llamarse" }]);
    const t = turn([CALL, { text: BUENA }], { completeRetry: retry.complete });
    const a = await t.run();
    expect(a.text).toBe(BUENA);
    expect(retry.requests).toHaveLength(0);
    expect(t.usos).toEqual([{ route: "barato", llmCalls: 2, escalated: false, costUsd: 0, model: "scripted/data-chat" }]);
  });

  it("guardia rechazada y la escalada acierta: UNA llamada escalada y ruta escalado", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const t = turn([CALL, { text: INVENTADA }], { completeRetry: retry.complete });
    const a = await t.run();
    expect(a.text).toBe(BUENA);
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0]!.tools).toBeUndefined();
    expect(retry.requests[0]!.maxOutputTokens).toBe(350);
    expect(t.usos[0]).toMatchObject({ route: "escalado", llmCalls: 3, escalated: true });
  });

  it("guardia rechazada y la escalada TAMBIEN inventa: sigue siendo UNA llamada escalada y se muestra el determinista", async () => {
    const retry = scriptedCompletion([{ text: "Vendiste $77,777 MXN." }, { text: "Vendiste $55,555 MXN." }]);
    const t = turn([CALL, { text: INVENTADA }], { completeRetry: retry.complete });
    const a = await t.run();
    expect(a.text).toBe(DETERMINISTA);
    expect(retry.requests).toHaveLength(1); // nunca una segunda escalada
    expect(t.usos[0]).toMatchObject({ route: "determinista", escalated: true, llmCalls: 3 });
  });

  it("la escalada lanza (proveedor caido, tope agotado): determinista, sin segunda llamada y sin tumbar el turno", async () => {
    let llamadas = 0;
    const errores: string[] = [];
    const t = turn([CALL, { text: INVENTADA }], {
      completeRetry: async () => {
        llamadas += 1;
        throw new Error("proveedor caido");
      },
      onError: (w) => errores.push(w),
    });
    const a = await t.run();
    expect(a.status).toBe("ok");
    expect(a.text).toBe(DETERMINISTA);
    expect(llamadas).toBe(1);
    expect(errores).toContain("llm_retry");
  });

  it("la escalada que se cuelga se corta en llmCallTimeoutMs y cae al determinista", async () => {
    const t = turn([CALL, { text: INVENTADA }], { completeRetry: () => new Promise<LlmCompletionResult>(() => {}), limits: { llmCallTimeoutMs: 30 } });
    const a = await t.run();
    expect(a.text).toBe(DETERMINISTA);
  });

  it("una narrativa demasiado larga tambien es fallo de la guardia: una escalada", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const t = turn([CALL, { text: `${BUENA} `.repeat(30) }], { completeRetry: retry.complete });
    const a = await t.run();
    expect(a.text).toBe(BUENA);
    expect(retry.requests).toHaveLength(1);
  });

  it("sin completeRetry configurado: determinista directo (sin escalada)", async () => {
    const t = turn([CALL, { text: INVENTADA }]);
    const a = await t.run();
    expect(a.text).toBe(DETERMINISTA);
    expect(t.usos[0]).toMatchObject({ route: "determinista", escalated: false, llmCalls: 2 });
  });

  it("narrativa vacia (no hay cifras inventadas que corregir): no se escala", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const t = turn([CALL, { text: "" }], { completeRetry: retry.complete });
    await t.run();
    expect(retry.requests).toHaveLength(0);
  });

  it("una consulta directa (sin IA) nunca escala y reporta ruta directa con 0 llamadas", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const t = turn([], { completeRetry: retry.complete, directTool: "ventas_por_dia", question: "" });
    const a = await t.run();
    expect(a.status).toBe("ok");
    expect(retry.requests).toHaveLength(0);
    expect(t.llm.requests).toHaveLength(0);
    expect(t.usos).toEqual([{ route: "directa", llmCalls: 0, escalated: false, costUsd: 0 }]);
  });

  it("el costo reportado por el proveedor se suma entre la llamada barata y la escalada", async () => {
    const costoso = (costUsd: number, text: string, extra: Partial<LlmCompletionResult> = {}) =>
      async (): Promise<LlmCompletionResult> => ({ text, model: "m", tokensIn: 1, tokensOut: 1, costUsd, ...extra });
    let n = 0;
    const barato = async (): Promise<LlmCompletionResult> => {
      n += 1;
      return n === 1
        ? { text: "", toolCalls: [{ id: "c1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' }], model: "barato/m", tokensIn: 1, tokensOut: 1, costUsd: 0.0001 }
        : { text: INVENTADA, model: "barato/m", tokensIn: 1, tokensOut: 1, costUsd: 0.0002 };
    };
    const usos: DataChatUsage[] = [];
    await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      complete: barato,
      completeRetry: costoso(0.0005, BUENA, { model: "escalado/m" }),
      now: NOW,
      onUso: (u) => usos.push(u),
    });
    expect(usos).toEqual([{ route: "escalado", llmCalls: 3, escalated: true, costUsd: 0.0008, model: "barato/m" }]);
  });

  it("un onUso que lanza no tumba el turno", async () => {
    const errores: string[] = [];
    const t = turn([CALL, { text: BUENA }], {
      onUso: () => {
        throw new Error("log caido");
      },
      onError: (w) => errores.push(w),
    });
    const a = await t.run();
    expect(a.text).toBe(BUENA);
    expect(errores).toContain("on_uso");
  });
});
