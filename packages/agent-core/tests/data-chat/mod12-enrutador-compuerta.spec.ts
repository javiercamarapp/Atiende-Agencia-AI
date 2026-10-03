// MOD-12: enrutador de turno (plataforma:enrutador_turno) y compuerta de escalamiento (plataforma:compuerta_escalamiento) del motor del Copiloto.
// LLM guionado (sin red). Regla: si el rol no esta, esta apagado, falla o responde algo ambiguo, el comportamiento es EXACTAMENTE el de siempre.
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "../../src/gateway/index.js";
import { gatewayCompletion } from "../../src/data-chat/gateway-completion.js";
import { RoleDailyTurnLimitExceededError } from "../../src/gateway/errors.js";
import { runDataChatTurn, type RunDataChatTurnOptions } from "../../src/data-chat/engine.js";
import { scriptedCompletion, type ScriptStep } from "../../src/data-chat/scripted-llm.js";
import type { DataChatUsage } from "../../src/data-chat/types.js";
import { MemoryAudit, NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

const CALL: ScriptStep = { toolCalls: [{ name: "ventas_por_dia", argumentsJson: JSON.stringify({ periodo: "esta_semana" }) }] };
const DETERMINISTA = "Ventas del periodo: $2,480.50 MXN en 20 pedidos.";
const BUENA = "Vendiste $2,480.50 MXN en 20 pedidos.";
const INVENTADA = "Vendiste $99,000 MXN.";

function run(over: Partial<RunDataChatTurnOptions> & { complete: NonNullable<RunDataChatTurnOptions["complete"]> }) {
  const usos: DataChatUsage[] = [];
  const audit = new MemoryAudit();
  const errores: string[] = [];
  const p = runDataChatTurn({
    catalog: catalogOf(salesTool()),
    scope: SCOPE_A,
    question: "¿Cuánto vendí esta semana?",
    now: NOW,
    audit,
    onUso: (u) => usos.push(u),
    onError: (where) => errores.push(where),
    ...over,
  });
  return { p, usos, audit, errores };
}

describe("enrutador de turno", () => {
  it("ESCALAR: TODO el turno corre en el modelo de reintento, el modelo base no se llama, la ruta es 'escalado' y no hay segunda escalada", async () => {
    const base = scriptedCompletion([CALL, { text: BUENA }]);
    const fuerte = scriptedCompletion([CALL, { text: BUENA }]);
    const router = scriptedCompletion([{ text: "ESCALAR" }]);
    const t = run({ complete: base.complete, completeRetry: fuerte.complete, completeRouter: router.complete });
    const a = await t.p;
    expect(a.status).toBe("ok");
    expect(a.text).toBe(BUENA);
    expect(base.requests).toHaveLength(0);
    expect(fuerte.requests).toHaveLength(2);
    expect(router.requests).toHaveLength(1);
    expect(t.usos).toEqual([expect.objectContaining({ route: "escalado", escalated: true, llmCalls: 3 })]);
  });

  it("ESCALAR y la narrativa del modelo fuerte no pasa la guardia: texto determinista, sin otra llamada escalada", async () => {
    const fuerte = scriptedCompletion([CALL, { text: INVENTADA }]);
    const t = run({ complete: scriptedCompletion([CALL]).complete, completeRetry: fuerte.complete, completeRouter: scriptedCompletion([{ text: "escalar." }]).complete });
    const a = await t.p;
    expect(a.text).toBe(DETERMINISTA);
    expect(fuerte.requests).toHaveLength(2);
  });

  it("BASE (o cualquier respuesta rara): flujo de siempre en el modelo base, sin tocar el de reintento", async () => {
    for (const texto of ["BASE", "no se", "", "ESCALARLO TODO PORFAVOR YA?? (no)"]) {
      const base = scriptedCompletion([CALL, { text: BUENA }]);
      const fuerte = scriptedCompletion([{ text: BUENA }]);
      const a = await run({ complete: base.complete, completeRetry: fuerte.complete, completeRouter: scriptedCompletion([{ text: texto }]).complete }).p;
      expect(a.text, texto).toBe(BUENA);
      expect(base.requests, texto).toHaveLength(2);
      expect(fuerte.requests, texto).toHaveLength(0);
    }
  });

  it("el enrutador recibe la pregunta SIN PII y sin filas de datos", async () => {
    const router = scriptedCompletion([{ text: "BASE" }]);
    await run({
      complete: scriptedCompletion([CALL, { text: BUENA }]).complete,
      completeRetry: scriptedCompletion([{ text: BUENA }]).complete,
      completeRouter: router.complete,
      question: "¿Cuánto vendí? escríbeme a juan.perez@example.com o al 55 1234 5678",
    }).p;
    const visto = JSON.stringify(router.requests[0]);
    expect(visto).not.toContain("juan.perez@example.com");
    expect(visto).not.toContain("1234 5678");
    expect(router.requests[0]!.tools).toBeUndefined();
  });

  it("si el enrutador falla (interruptor apagado, tope, tiempo, error) el turno sigue como siempre y el fallo se reporta aparte", async () => {
    const base = scriptedCompletion([CALL, { text: BUENA }]);
    const t = run({
      complete: base.complete,
      completeRetry: scriptedCompletion([{ text: BUENA }]).complete,
      completeRouter: scriptedCompletion([() => new Error("kill switch")]).complete,
    });
    const a = await t.p;
    expect(a.status).toBe("ok");
    expect(base.requests).toHaveLength(2);
    expect(t.errores).toContain("router");
  });

  it("ESCALAR pero el rol de reintento agoto su tope diario: el turno vuelve al modelo base (no cae a modo sin IA) y la ruta es 'barato'", async () => {
    const base = scriptedCompletion([CALL, { text: BUENA }]);
    const fuerte = scriptedCompletion([() => new RoleDailyTurnLimitExceededError("hoteles:data_chat_retry", "org", 100, 100), () => new RoleDailyTurnLimitExceededError("hoteles:data_chat_retry", "org", 100, 100)]);
    const t = run({ complete: base.complete, completeRetry: fuerte.complete, completeRouter: scriptedCompletion([{ text: "ESCALAR" }]).complete });
    const a = await t.p;
    expect(a.status).toBe("ok");
    expect(a.text).toBe(BUENA);
    expect(base.requests).toHaveLength(2);
    expect(t.usos[0]).toEqual(expect.objectContaining({ route: "barato" }));
  });

  it("si el enrutador no llega al modelo (interruptor apagado) NO cuenta como llamada del turno", async () => {
    const t = run({
      complete: scriptedCompletion([CALL, { text: BUENA }]).complete,
      completeRetry: scriptedCompletion([{ text: BUENA }]).complete,
      completeRouter: scriptedCompletion([() => new Error("kill switch")]).complete,
    });
    await t.p;
    expect(t.usos).toEqual([expect.objectContaining({ llmCalls: 2 })]);
  });

  it("sin modelo de reintento el enrutador ni se invoca (no hay a quien escalar); sin enrutador, cero llamadas extra", async () => {
    const router = scriptedCompletion([{ text: "ESCALAR" }]);
    await run({ complete: scriptedCompletion([CALL, { text: BUENA }]).complete, completeRouter: router.complete }).p;
    expect(router.requests).toHaveLength(0);
    const sin = scriptedCompletion([CALL, { text: BUENA }]);
    const t = run({ complete: sin.complete, completeRetry: scriptedCompletion([{ text: BUENA }]).complete });
    await t.p;
    expect(t.usos[0]).toMatchObject({ llmCalls: 2 });
  });

  it("una consulta directa (chip) nunca pasa por el enrutador", async () => {
    const router = scriptedCompletion([{ text: "ESCALAR" }]);
    await run({ complete: scriptedCompletion([{ text: "x" }]).complete, completeRetry: scriptedCompletion([{ text: BUENA }]).complete, completeRouter: router.complete, directTool: "ventas_por_dia" }).p;
    expect(router.requests).toHaveLength(0);
  });

  it("el costo del enrutador se suma al del turno (costo real = suma de lo que reporto cada llamada)", async () => {
    const con = (costUsd: number, text: string, toolCalls?: { id: string; name: string; argumentsJson: string }[]) => async () => ({ text, toolCalls, model: "m", tokensIn: 1, tokensOut: 1, costUsd });
    let n = 0;
    const fuerte = async () => {
      n += 1;
      return n === 1 ? { text: "", toolCalls: [{ id: "c1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' }], model: "fuerte/m", tokensIn: 1, tokensOut: 1, costUsd: 0.0003 } : { text: BUENA, model: "fuerte/m", tokensIn: 1, tokensOut: 1, costUsd: 0.0004 };
    };
    const t = run({ complete: con(0, "x"), completeRetry: fuerte, completeRouter: con(0.00005, "ESCALAR"), auditRole: "restaurantes:data_chat" });
    await t.p;
    expect(t.usos[0]).toMatchObject({ costMicroUsd: 750, llmCalls: 3, model: "fuerte/m" });
    expect(t.audit.entries.find((e) => e.costMicroUsd !== undefined)).toMatchObject({ costMicroUsd: 750, route: "escalado" });
  });
});

describe("compuerta de escalamiento", () => {
  it("ESCALAR: hace la llamada escalada de siempre", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const gate = scriptedCompletion([{ text: "ESCALAR" }]);
    const t = run({ complete: scriptedCompletion([CALL, { text: INVENTADA }]).complete, completeRetry: retry.complete, completeGate: gate.complete });
    const a = await t.p;
    expect(a.text).toBe(BUENA);
    expect(gate.requests).toHaveLength(1);
    expect(retry.requests).toHaveLength(1);
    expect(t.usos[0]).toMatchObject({ route: "escalado", escalated: true });
  });

  it("DETERMINISTA: NO se hace la llamada escalada y se muestra el texto determinista", async () => {
    const retry = scriptedCompletion([{ text: BUENA }]);
    const t = run({ complete: scriptedCompletion([CALL, { text: INVENTADA }]).complete, completeRetry: retry.complete, completeGate: scriptedCompletion([{ text: "determinista" }]).complete });
    const a = await t.p;
    expect(a.text).toBe(DETERMINISTA);
    expect(retry.requests).toHaveLength(0);
    expect(t.usos[0]).toMatchObject({ route: "determinista", escalated: false });
  });

  it("respuesta rara o fallo de la compuerta: escala como siempre (fail-safe = comportamiento actual)", async () => {
    for (const gate of [scriptedCompletion([{ text: "quiza" }]), scriptedCompletion([() => new Error("apagado")])]) {
      const retry = scriptedCompletion([{ text: BUENA }]);
      const a = await run({ complete: scriptedCompletion([CALL, { text: INVENTADA }]).complete, completeRetry: retry.complete, completeGate: gate.complete }).p;
      expect(a.text).toBe(BUENA);
      expect(retry.requests).toHaveLength(1);
    }
  });

  it("la compuerta no se consulta si la narrativa paso la guardia (cero costo extra en el camino feliz)", async () => {
    const gate = scriptedCompletion([{ text: "DETERMINISTA" }]);
    await run({ complete: scriptedCompletion([CALL, { text: BUENA }]).complete, completeRetry: scriptedCompletion([{ text: BUENA }]).complete, completeGate: gate.complete }).p;
    expect(gate.requests).toHaveLength(0);
  });

  it("la compuerta recibe la narrativa ya saneada (sin PII) y el conteo de cifras fuera de los resultados", async () => {
    const gate = scriptedCompletion([{ text: "ESCALAR" }]);
    await run({
      complete: scriptedCompletion([CALL, { text: "Vendiste $99,000 MXN, escribe a ana@example.com" }]).complete,
      completeRetry: scriptedCompletion([{ text: BUENA }]).complete,
      completeGate: gate.complete,
    }).p;
    const visto = JSON.stringify(gate.requests[0]);
    expect(visto).not.toContain("ana@example.com");
    expect(visto).toContain("Cifras del texto que NO estan en los resultados: 1");
  });
});

describe("interruptor apagado del rol: el rol NO se invoca (LlmGateway real)", () => {
  it("con el interruptor del enrutador apagado el proveedor del enrutador no recibe llamadas y el turno es el de siempre", async () => {
    const proveedor = (id: string, script: ConstructorParameters<typeof FakeLlmProvider>[0]["script"]) => new FakeLlmProvider({ id, script });
    const ok = (text: string, toolCalls?: { id: string; name: string; argumentsJson: string }[]) => async () => ({ text, toolCalls, model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 });
    let paso = 0;
    const base = proveedor("openrouter:base", async () => (++paso === 1 ? ok("", [{ id: "c1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' }])() : ok(BUENA)()));
    const routerP = proveedor("openrouter:router", ok("ESCALAR"));
    const fuerteP = proveedor("openrouter:fuerte", ok(BUENA));
    const g = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 },
      killSwitch: { blockedBy: async (role) => (role === "plataforma:enrutador_turno" ? "agente:plataforma:enrutador_turno" : null) },
    });
    g.registerLadder("restaurantes:data_chat", [base]);
    g.registerLadder("restaurantes:data_chat_retry", [fuerteP]);
    g.registerLadder("plataforma:enrutador_turno", [routerP]);
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      now: NOW,
      complete: gatewayCompletion(g, { tenantId: "org-a", role: "restaurantes:data_chat" }),
      completeRetry: gatewayCompletion(g, { tenantId: "org-a", role: "restaurantes:data_chat_retry" }),
      completeRouter: gatewayCompletion(g, { tenantId: "org-a", role: "plataforma:enrutador_turno" }),
    });
    expect(a.status).toBe("ok");
    expect(routerP.callCount).toBe(0);
    expect(fuerteP.callCount).toBe(0);
    expect(base.callCount).toBe(2);
  });
});
