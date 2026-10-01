// C-15 -- la personalidad guardada desde el panel llega de verdad al prompt del turno de WhatsApp (no es una maqueta), y una
// base sin migrar no cambia ni rompe el turno (misma disciplina de SAVEPOINT que `findTenantConfig`).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { APPOINTMENT_HARD_RULES, createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function makeGateway(captured: LlmCompletionRequest[]) {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [
    new FakeLlmProvider({
      id: "p",
      script: (request): LlmCompletionResult => {
        captured.push(request);
        return { text: "¿En qué te ayudo?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    }),
  ]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  return gateway;
}

const turno = (organizationId: string) => ({
  organizationId,
  phone: "+5219990000000",
  messages: [{ role: "user" as const, content: "hola" }],
  customer: { isNew: true as const, fullName: null, upcomingAppointments: [] },
});

describe("el agente de WhatsApp de citas usa la personalidad del negocio (C-15)", () => {
  it("lo que se guarda en el panel llega al system prompt del turno, con las reglas duras intactas", async () => {
    const organizationId = randomUUID();
    const repo = new InMemoryCitasRepository();
    repo.seedOrganization({ id: organizationId, slug: "org-a", name: "Negocio A" });
    await repo.saveWhatsappAgentConfig(organizationId, 0, "actualizado", { agentName: "Sofi", toneStyle: "formal_directo", greetingText: "Bienvenido a Clínica Sol", rulesText: "No des diagnósticos" });
    const captured: LlmCompletionRequest[] = [];
    const handler = createLlmWhatsAppTurnHandler(repo, makeGateway(captured), { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage(turno(organizationId));
    const system = captured[0]!.system;
    expect(system).toContain("Eres Sofi, el asistente de WhatsApp");
    expect(system).toContain("trata al cliente de usted");
    expect(system).toContain("Bienvenido a Clínica Sol");
    expect(system).toContain("- No des diagnósticos");
    expect(system).toContain(APPOINTMENT_HARD_RULES);
  });

  it("la personalidad de OTRA organizacion no se filtra al prompt", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const repo = new InMemoryCitasRepository();
    repo.seedOrganization({ id: a, slug: "org-a", name: "A" });
    repo.seedOrganization({ id: b, slug: "org-b", name: "B" });
    await repo.saveWhatsappAgentConfig(a, 0, "actualizado", { agentName: "SoloDeA", toneStyle: null, greetingText: null, rulesText: null });
    const captured: LlmCompletionRequest[] = [];
    await createLlmWhatsAppTurnHandler(repo, makeGateway(captured), { defaultRole: "default", escalatedRole: "escalated" }).handleInboundMessage(turno(b));
    expect(captured[0]!.system).not.toContain("SoloDeA");
    expect(captured[0]!.system).toContain("Eres el asistente de WhatsApp de");
  });

  it("base sin migrar (42883): el turno responde con el prompt de siempre y la sesion NO queda abortada", async () => {
    const organizationId = randomUUID();
    const session = new AbortAwareFakeSession([
      { match: /from citas\.tenant_config/, respond: () => [] },
      { match: /whatsapp_agent_config_envio/, respond: () => Object.assign(new Error("function citas.whatsapp_agent_config_envio(uuid) does not exist"), { code: "42883" }) },
      { match: /select 1/, respond: () => [] },
    ]);
    const captured: LlmCompletionRequest[] = [];
    const handler = createLlmWhatsAppTurnHandler(new PostgresCitasRepository(session), makeGateway(captured), { defaultRole: "default", escalatedRole: "escalated" });
    await handler.handleInboundMessage(turno(organizationId));
    expect(captured[0]!.system).toContain("Eres el asistente de WhatsApp de este negocio");
    expect(captured[0]!.system).toContain("Tono cálido, directo, mensajes cortos");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
