// CHAT-07: tope diario de turnos por rol, subtope del Copiloto (30 % del tope mensual), costo real en la bitacora.
// LLM guionado (sin red) y reloj simulado.
import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  FakeLlmProvider,
  InMemoryBudgetLedgerStore,
  InMemoryCircuitBreakerStore,
  InMemoryOrgMonthlyBudgetStore,
  InMemoryRoleDailyTurnStore,
  LlmGateway,
  RoleDailyTurnLimitExceededError,
  isRoleDailyTurnLimitError,
  type LlmCompletionRequest,
} from "../../src/gateway/index.js";
import { gatewayCompletion } from "../../src/data-chat/gateway-completion.js";
import { runDataChatTurn } from "../../src/data-chat/engine.js";
import { NOW, MemoryAudit, SCOPE_A, catalogOf, salesTool } from "./support.js";

const ROLE = "restaurantes:data_chat";
const req = (): LlmCompletionRequest => ({ system: "s", messages: [{ role: "user", content: "hola" }] });

function gateway(opts: { roleTurnStore?: InMemoryRoleDailyTurnStore; monthly?: InMemoryOrgMonthlyBudgetStore; script?: ConstructorParameters<typeof FakeLlmProvider>[0]["script"] } = {}) {
  const provider = new FakeLlmProvider({ id: "openrouter:a", script: opts.script ?? (async () => ({ text: "ok", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0.0001 })) });
  const g = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 1000, maxTenantDailyUsd: 1000 },
    costEstimator: () => 0.00004, // 40 micro-USD por reserva
    ...(opts.roleTurnStore ? { roleTurnStore: opts.roleTurnStore } : {}),
    ...(opts.monthly ? { orgMonthlyBudgetStore: opts.monthly } : {}),
  });
  g.registerLadder(ROLE, [provider]);
  g.registerLadder("hoteles:whatsapp_agent", [provider]);
  return { g, provider };
}
const call = (g: LlmGateway, tenantId = "org-a", role = ROLE) => g.complete({ tenantId, runId: `r-${Math.random()}`, lane: "interactive", role, request: req() });

describe("tope diario de turnos por rol", () => {
  it("el turno 31 del dia de un rol con tope 30 se rechaza con motivo y NO llama al proveedor", async () => {
    let now = new Date("2026-10-02T15:00:00.000Z");
    const store = new InMemoryRoleDailyTurnStore({ defaultLimits: { [ROLE]: 30 }, now: () => now });
    const { g, provider } = gateway({ roleTurnStore: store });
    for (let i = 0; i < 30; i += 1) await call(g);
    expect(provider.callCount).toBe(30);
    const rejected = await call(g).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(RoleDailyTurnLimitExceededError);
    expect(isRoleDailyTurnLimitError(rejected)).toBe(true);
    expect(rejected).toMatchObject({ role: ROLE, organizationId: "org-a", used: 30, maxTurns: 30 });
    expect(provider.callCount).toBe(30);
    // El rechazo no consume cupo: otro rechazo reporta los mismos 30.
    expect(await call(g).catch((e: unknown) => e)).toMatchObject({ used: 30 });
    // Reloj simulado: al dia siguiente el cupo se renueva.
    now = new Date("2026-10-03T00:00:01.000Z");
    await expect(call(g)).resolves.toMatchObject({ text: "ok" });
    expect(provider.callCount).toBe(31);
  });

  it("el tope es por organizacion y por rol; el tope propio manda sobre el default; un rol sin tope no se limita", async () => {
    const store = new InMemoryRoleDailyTurnStore({ defaultLimits: { [ROLE]: 1 }, orgLimits: { [`org-b|${ROLE}`]: 3 } });
    const { g } = gateway({ roleTurnStore: store });
    await call(g, "org-a");
    await expect(call(g, "org-a")).rejects.toThrow(RoleDailyTurnLimitExceededError);
    await call(g, "org-b");
    await call(g, "org-b");
    await call(g, "org-b");
    await expect(call(g, "org-b")).rejects.toThrow(RoleDailyTurnLimitExceededError);
    for (let i = 0; i < 5; i += 1) await call(g, "org-a", "hoteles:whatsapp_agent");
  });

  it("turnos concurrentes: nunca pasan mas del tope", async () => {
    const store = new InMemoryRoleDailyTurnStore({ defaultLimits: { [ROLE]: 5 } });
    const { g, provider } = gateway({ roleTurnStore: store });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => call(g)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(provider.callCount).toBe(5);
  });

  it("en el motor: el turno rechazado responde en modo sin IA con las consultas directas y deja la fila sin_ia con motivo", async () => {
    const store = new InMemoryRoleDailyTurnStore({ defaultLimits: { [ROLE]: 0 + 1 } });
    const { g } = gateway({ roleTurnStore: store });
    await call(g); // agota el unico turno del dia
    const audit = new MemoryAudit();
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿cuánto vendí?",
      complete: gatewayCompletion(g, { tenantId: SCOPE_A.organizationId, role: ROLE }),
      audit,
      auditRole: ROLE,
      now: NOW,
    });
    expect(a.status).toBe("budget_exceeded");
    expect(a.noAi?.reason).toBe("budget");
    expect(a.noAi?.options.length).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({ tool: null, outcome: "budget_exceeded", errorCode: "role_daily_cap", route: "sin_ia", role: ROLE });
  });
});

describe("subtope mensual del Copiloto (30 %)", () => {
  it("las reservas concurrentes del Copiloto nunca pasan del 30 % del tope de la organizacion; otro rol sigue usando el resto", async () => {
    const monthly = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 1000, platformCapMicroUsd: 1_000_000 });
    const { g } = gateway({ monthly });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => call(g)));
    // 30 % de 1000 = 300 micro-USD; cada reserva estima 40: caben 7 (280) y la 8.a (320) se rechaza antes de llamar al proveedor.
    const aceptadas = results.filter((r) => r.status === "fulfilled").length;
    const rechazadas = results.filter((r) => r.status === "rejected");
    expect(aceptadas).toBe(7);
    expect(rechazadas).toHaveLength(13);
    for (const r of rechazadas) expect((r as PromiseRejectedResult).reason).toMatchObject({ scope: "copilot" });
    // Con el subtope agotado, un agente de WhatsApp sigue pudiendo reservar contra el resto del tope.
    await expect(call(g, "org-a", "hoteles:whatsapp_agent")).resolves.toMatchObject({ text: "ok" });
  });

  it("el rechazo por subtope en el motor cae al modo sin IA con fila sin_ia", async () => {
    const monthly = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 100, platformCapMicroUsd: 1_000_000 }); // subtope = 30 < 40
    const { g, provider } = gateway({ monthly });
    const audit = new MemoryAudit();
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿cuánto vendí?",
      complete: gatewayCompletion(g, { tenantId: SCOPE_A.organizationId, role: ROLE }),
      audit,
      auditRole: ROLE,
      now: NOW,
    });
    expect(a.noAi?.reason).toBe("budget");
    expect(provider.callCount).toBe(0);
    expect(audit.entries.at(-1)).toMatchObject({ outcome: "budget_exceeded", errorCode: "copiloto_subtope", route: "sin_ia" });
  });
});

describe("costo real registrado en la bitacora", () => {
  const CALL = { id: "c1", name: "ventas_por_dia", argumentsJson: '{"periodo":"esta_semana"}' };

  it("la fila de resumen del turno trae costMicroUsd = suma de lo que reporto el proveedor (1e6 * USD), modelo y rol; onUso coincide", async () => {
    let n = 0;
    const { g } = gateway({
      script: async () => {
        n += 1;
        return n === 1
          ? { text: "", toolCalls: [CALL], model: "barato/m", tokensIn: 5, tokensOut: 5, costUsd: 0.000123 }
          : { text: "Ventas del periodo: $2,480.50 MXN en 20 pedidos.", model: "barato/m", tokensIn: 5, tokensOut: 5, costUsd: 0.000456 };
      },
    });
    const audit = new MemoryAudit();
    const usos: unknown[] = [];
    const a = await runDataChatTurn({
      catalog: catalogOf(salesTool()),
      scope: SCOPE_A,
      question: "¿Cuánto vendí esta semana?",
      complete: gatewayCompletion(g, { tenantId: SCOPE_A.organizationId, role: ROLE }),
      audit,
      auditRole: ROLE,
      onUso: (u) => usos.push(u),
      now: NOW,
    });
    expect(a.status).toBe("ok");
    const resumen = audit.entries.find((e) => e.tool === null && e.costMicroUsd !== undefined);
    expect(resumen).toMatchObject({ outcome: "ok", route: "llm", costMicroUsd: 579, model: "barato/m", role: ROLE });
    expect(usos).toEqual([expect.objectContaining({ route: "barato", llmCalls: 2, costMicroUsd: 579 })]);
    // La fila de la herramienta no lleva costo (el costo vive en el resumen: no se cuenta dos veces).
    expect(audit.entries.filter((e) => e.costMicroUsd !== undefined)).toHaveLength(1);
  });

  it("sin auditRole el motor se comporta como siempre (ninguna fila de resumen)", async () => {
    const { g } = gateway();
    const audit = new MemoryAudit();
    await runDataChatTurn({ catalog: catalogOf(salesTool()), scope: SCOPE_A, question: "¿cuánto vendí?", complete: gatewayCompletion(g, { tenantId: "org-a", role: ROLE }), audit, now: NOW });
    expect(audit.entries.filter((e) => e.costMicroUsd !== undefined)).toHaveLength(0);
  });
});
