// MODO SIN IA del data-chat: cuando el modelo no esta disponible (proveedores caidos, tope de gasto
// agotado, interruptor de plataforma) la respuesta lo dice y devuelve el catalogo como opciones.
// Se prueba contra el LlmGateway REAL con proveedores falsos (sin red).
import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  FakeLlmProvider,
  InMemoryBudgetLedgerStore,
  InMemoryCircuitBreakerStore,
  InMemoryOrgMonthlyBudgetStore,
  LlmGateway,
  type GatewayKillSwitch,
} from "../../src/gateway/index.js";
import { gatewayCompletion } from "../../src/data-chat/gateway-completion.js";
import { runDataChatTurn } from "../../src/data-chat/engine.js";
import { NOW, SCOPE_A, catalogOf, salesTool } from "./support.js";

const ROLE = "restaurantes:data_chat";

function gatewayWith(providers: FakeLlmProvider[], extra: { killSwitch?: GatewayKillSwitch; monthlyCapMicroUsd?: number } = {}): LlmGateway {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 2, maxTenantDailyUsd: 50 },
    killSwitch: extra.killSwitch,
    orgMonthlyBudgetStore: extra.monthlyCapMicroUsd === undefined ? undefined : new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: extra.monthlyCapMicroUsd, platformCapMicroUsd: 1_000_000_000 }),
  });
  gateway.registerLadder(ROLE, providers);
  return gateway;
}

const ask = (gateway: LlmGateway) =>
  runDataChatTurn({
    catalog: catalogOf(salesTool()),
    scope: SCOPE_A,
    question: "¿cuánto vendí?",
    complete: gatewayCompletion(gateway, { tenantId: SCOPE_A.organizationId, role: ROLE }),
    now: NOW,
  });

const down = (id: string) => new FakeLlmProvider({ id, failWith: () => Object.assign(new Error("OpenRouter 503: caido"), { status: 503 }) });

describe("data-chat: modo sin IA", () => {
  it("toda la escalera cae (OpenRouter falla en todos los modelos) -> lo dice y devuelve el catalogo, sin cifras", async () => {
    const a = await ask(gatewayWith([down("openrouter:a"), down("openrouter:b")]));
    expect(a.status).toBe("unavailable");
    expect(a.noAi?.reason).toBe("provider_down");
    expect(a.noAi?.options).toEqual([{ tool: "ventas_por_dia", label: "Ventas por día", description: "Ventas y pedidos por día." }]);
    expect(a.text).toMatch(/IA no está disponible/);
    expect(a.text).toContain("Ventas por día");
    expect(a.blocks).toEqual([]);
    expect(a.text).not.toMatch(/openrouter|503/i);
  });

  it("presupuesto agotado -> budget_exceeded en modo sin IA, sin llamar al proveedor", async () => {
    const provider = new FakeLlmProvider({ id: "openrouter:a" });
    const a = await ask(gatewayWith([provider], { monthlyCapMicroUsd: 1 }));
    expect(a.status).toBe("budget_exceeded");
    expect(a.noAi?.reason).toBe("budget");
    expect(a.noAi?.options.length).toBe(1);
    expect(provider.callCount).toBe(0);
  });

  it("interruptor de plataforma apagado para el rol -> modo sin IA con razon kill_switch, sin llamar al proveedor", async () => {
    const provider = new FakeLlmProvider({ id: "openrouter:a" });
    const a = await ask(gatewayWith([provider], { killSwitch: { blockedBy: async () => `agente:${ROLE}` } }));
    expect(a.status).toBe("unavailable");
    expect(a.noAi?.reason).toBe("kill_switch");
    expect(a.text).toMatch(/pausada/);
    expect(provider.callCount).toBe(0);
  });

  it("con IA disponible la respuesta NO trae noAi (cero cambio de comportamiento)", async () => {
    const provider = new FakeLlmProvider({ id: "openrouter:a", script: async () => ({ text: "¿De qué periodo?", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0 }) });
    const a = await ask(gatewayWith([provider]));
    expect(a.noAi).toBeUndefined();
  });
});
