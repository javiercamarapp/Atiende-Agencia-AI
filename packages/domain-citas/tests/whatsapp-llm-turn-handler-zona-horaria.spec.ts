// auditoría f3-zona-horaria-citas-rentas — bug real encontrado: `getAgentConfig`
// (../src/whatsapp/llm-turn-handler.ts) devolvía SIEMPRE `FALLBACK_CONFIG.timezone`
// ("America/Mexico_City") sin importar la organización real, aunque el mismo
// `handleInboundMessage` YA lee `citas.tenant_config` (para el rubro, ver
// `verticalFaqsBlock`) unas líneas después -- la zona horaria real
// (`citas.tenant_config.default_timezone`, editable desde el panel, ver
// `apps/api/.../citas/admin.ts::optionalTimeZone`) nunca llegaba al prompt del LLM.
// Efecto real: "FECHA DE HOY" (usada por el LLM para resolver "hoy"/"mañana" antes
// de llamar `consultar_disponibilidad`, ver `currentDateContext`) y el saludo por
// hora (`saludoSegunHora`) siempre se calculaban en hora de CDMX, incluso para un
// negocio en otra zona con su `default_timezone` ya configurado.
//
// Instante elegido (verificado con Intl.DateTimeFormat antes de escribir este
// test, ver comentario de cada caso): 2026-01-15T05:30:00.000Z es un instante real
// donde America/Mexico_City (UTC-6, sin horario de verano desde la reforma de
// 2022) y America/Cancún (UTC-5, tampoco tiene DST) calculan un DÍA DE CALENDARIO
// distinto -- no un ejemplo inventado de offset, la diferencia de "hoy" es real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";

// Reloj falso fijo -- el mismo instante real UTC para ambos casos del test, solo
// cambia la zona horaria configurada por negocio.
const INSTANTE_UTC = new Date("2026-01-15T05:30:00.000Z");

function makeGateway(capturedRequests: LlmCompletionRequest[]) {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [
    new FakeLlmProvider({
      id: "p",
      script: (request): LlmCompletionResult => {
        capturedRequests.push(request);
        // Sin tool calls -- el handler responde en el primer turno, nunca necesita
        // proveedores/servicios/citas seedeados para este test (que solo audita el
        // contenido del system prompt, no el loop de tool-use).
        return { text: "¿En qué te ayudo?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    }),
  ]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  return gateway;
}

async function runTurnoConZona(defaultTimezone: string | undefined): Promise<string> {
  const organizationId = randomUUID();
  const repo = new InMemoryCitasRepository();
  repo.seedOrganization({ id: organizationId, slug: `org-${organizationId}`, name: "Negocio de prueba" });
  if (defaultTimezone !== undefined) {
    repo.seedTenantConfig({ organizationId, defaultTimezone });
  }

  const capturedRequests: LlmCompletionRequest[] = [];
  const gateway = makeGateway(capturedRequests);
  const handler = createLlmWhatsAppTurnHandler(repo, gateway, {
    defaultRole: "default",
    escalatedRole: "escalated",
    now: () => INSTANTE_UTC,
  });

  await handler.handleInboundMessage({
    organizationId,
    phone: "+5219990000000",
    messages: [{ role: "user", content: "hola" }],
    customer: { isNew: true, fullName: null, upcomingAppointments: [] },
  });

  expect(capturedRequests).toHaveLength(1);
  return capturedRequests[0]!.system;
}

describe("createLlmWhatsAppTurnHandler (citas) — zona horaria REAL del negocio en el prompt del LLM", () => {
  it("con default_timezone='America/Cancun' configurado, la FECHA DE HOY del prompt es 2026-01-15 (Cancún, UTC-5), NUNCA 2026-01-14 (CDMX)", async () => {
    // Verificado arriba: en este instante UTC, Cancún todavía ve el 15; CDMX ya
    // retrocedió al 14. Si el bug siguiera vivo (timezone fija a CDMX) este
    // aserto fallaría con "2026-01-14".
    const system = await runTurnoConZona("America/Cancun");
    expect(system).toContain("2026-01-15");
    expect(system).not.toContain("2026-01-14");
  });

  it("sin default_timezone configurado (organización nueva, sin fila en tenant_config), cae al default de plataforma (CDMX) y la fecha es 2026-01-14 -- comportamiento previo preservado", async () => {
    const system = await runTurnoConZona(undefined);
    expect(system).toContain("2026-01-14");
    expect(system).not.toContain("2026-01-15");
  });

  it("con default_timezone corrupto (no IANA real, dato legado), resolverZonaHorariaNegocio cae CERRADO al default de plataforma en vez de lanzar RangeError", async () => {
    const system = await runTurnoConZona("no-es-un-timezone-real");
    expect(system).toContain("2026-01-14");
  });
});
