// QA R1 agentes-19 -- el presupuesto del turno de WhatsApp (45 s en el origen) superaba la vida de la funcion del webhook (30 s en
// vercel.json): con un proveedor lento Vercel mataba la funcion a media vuelta, el cliente no recibia nada y Meta reintentaba otro turno
// pagado. Este defecto ya quedo corregido en main (TURN_BUDGET_POR_OMISION_MS); esta prueba lo deja cubierto desde la lente del hallazgo
// (proveedor de 12 s por llamada y las MISMAS opciones que apps/api/src/production/deps.ts, sin turnBudgetMs).
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { buildInMemoryPmWorld } from "../../src/seed/pm-world.ts";
import { FUNCION_MAX_MS } from "../../src/whatsapp/inbound.ts";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import { MARTES_14, base, plan } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("agentes-19: el turno cabe en la vida de la funcion del webhook", () => {
  it("proveedor de 12 s por llamada: el turno se rinde con respuesta honesta antes de los 30 s de la funcion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14));
    const w = await buildInMemoryPmWorld(plan);
    const t7 = w.propertyBySlug.get("garcia-lavin")!;
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    const lento = new FakeLlmProvider({
      id: "lento",
      script: () => {
        vi.setSystemTime(new Date(Date.now() + 12_000));
        return { text: "", toolCalls: [{ id: `c${Date.now()}`, name: "buscar_producto", argumentsJson: JSON.stringify({ query: "pastor", branch_slug: "garcia-lavin" }) }], ...base };
      },
    });
    gateway.registerLadder("default", [lento]);
    gateway.registerLadder("escalated", [lento]);
    const handler = createLlmWhatsAppTurnHandler(w.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const inicio = Date.now();
    const turn = await handler.handleInboundMessage({ organizationId: w.organizationId, phone: "+5219990000021", messages: [{ role: "user", content: "pastor?" }], customer: { isNew: true }, propertyId: t7 });
    expect(Date.now() - inicio).toBeLessThanOrEqual(FUNCION_MAX_MS);
    expect(turn.reply.length).toBeGreaterThan(0);
  });
});
