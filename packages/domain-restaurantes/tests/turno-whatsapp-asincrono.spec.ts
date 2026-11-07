// Turno de WhatsApp ASINCRONO (cerebro v2): el webhook acusa a Meta al terminar la fase A y la fase B corre despues con la vida extendida de la
// funcion (FUNCION_ASINCRONA_MAX_MS). Aqui se prueba la parte de dominio: el turno usa como tope el fin de SU fase (no el presupuesto de 18 s del
// camino sincrono) y el lease de conversacion cubre la funcion larga.
// LLM simulado por guion (FakeLlmProvider), repositorio en memoria y reloj falso: sin red ni base real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler, TURN_BUDGET_POR_OMISION_MS } from "../src/whatsapp/llm-turn-handler.ts";
import { FUNCION_ASINCRONA_MAX_MS, LEASE_RAFAGA_SEGUNDOS, LEASE_TURNO_ASINCRONO_SEGUNDOS, MARGEN_CIERRE_TURNO_MS, recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

function gatewayLento(latenciaMs: number) {
  let n = 0;
  const provider = new FakeLlmProvider({
    id: "lento",
    script: async () => {
      await new Promise((ok) => setTimeout(ok, latenciaMs));
      n += 1;
      return llamada(`c${n}`, "consultar_sucursal", { branch_slug: "fco-montejo" });
    },
  });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [provider]);
  return { gateway, provider };
}

afterEach(() => {
  vi.useRealTimers();
});

async function medirTurno(turnoAsincrono: boolean): Promise<{ ms: number; llamadas: number }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const f = buildRestaurantFixture();
  // 4 s por llamada con el perfil PM (8 vueltas): el turno completo pide ~32 s, mas que los 18 s del presupuesto sincrono.
  const { gateway, provider } = gatewayLento(4_000);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
  const inicio = Date.now();
  let fin: number | null = null;
  const turno = handler
    .handleInboundMessage({
      organizationId: f.organizationId,
      phone: "+5219990005555",
      messages: [{ role: "user", content: "medio de pastor, uno de bistec, 3 cocas y 2 de suadero para recoger" }],
      customer: { isNew: true },
      propertyId: null,
      finTurnoMs: inicio + FUNCION_ASINCRONA_MAX_MS - MARGEN_CIERRE_TURNO_MS,
      ...(turnoAsincrono ? { turnoAsincrono: true as const } : {}),
    })
    .then((r) => {
      fin = Date.now();
      return r;
    });
  for (let i = 0; i < 120 && fin === null; i++) await vi.advanceTimersByTimeAsync(1_000);
  const r = await turno;
  expect(r.reply.length).toBeGreaterThan(0);
  return { ms: fin! - inicio, llamadas: provider.callCount };
}

describe("turno asincrono: el tope es el fin de la fase, no el presupuesto de 18 s", () => {
  it("con turnoAsincrono el turno lento sigue despues de los 18 s y termina antes de finTurnoMs", async () => {
    const { ms, llamadas } = await medirTurno(true);
    expect(ms).toBeGreaterThan(TURN_BUDGET_POR_OMISION_MS + 4_000);
    // La ultima llamada arranca antes del fin del turno y tarda a lo mas lo suyo.
    expect(ms).toBeLessThanOrEqual(FUNCION_ASINCRONA_MAX_MS - MARGEN_CIERRE_TURNO_MS + 4_000);
    expect(llamadas).toBeGreaterThan(5);
  });

  it("sin la marca (camino sincrono) el mismo finTurnoMs largo NO estira el presupuesto: manda el de 18 s", async () => {
    const { ms } = await medirTurno(false);
    expect(ms).toBeLessThanOrEqual(TURN_BUDGET_POR_OMISION_MS + 4_000);
  });
});

describe("fase B asincrona: fin del turno, marca y lease", () => {
  it("responderTrasEspera con turnoAsincrono manda la marca y finTurnoMs = fin de la funcion - margen", async () => {
    const f = buildRestaurantFixture();
    const vistos: Array<{ finTurnoMs: number | undefined; turnoAsincrono: boolean | undefined }> = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ finTurnoMs, turnoAsincrono }) {
        vistos.push({ finTurnoMs, turnoAsincrono });
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    const tel = "+5219991234567";
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.a1", phone: tel, body: "Hola", leaseSegundos: LEASE_TURNO_ASINCRONO_SEGUNDOS });
    await responderTrasEspera(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.a1", phone: tel, phoneNumberId: "123", finFuncionMs: 1_000_000, turnoAsincrono: true });
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.a2", phone: tel, body: "Otro" });
    await responderTrasEspera(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.a2", phone: tel, phoneNumberId: "123", finFuncionMs: 1_000_000 });
    expect(vistos).toEqual([
      { finTurnoMs: 1_000_000 - MARGEN_CIERRE_TURNO_MS, turnoAsincrono: true },
      { finTurnoMs: 1_000_000 - MARGEN_CIERRE_TURNO_MS, turnoAsincrono: undefined },
    ]);
  });

  it("el lease de conversacion del modo asincrono cubre la funcion de 60 s; el de siempre se queda en 45 s", async () => {
    expect(LEASE_TURNO_ASINCRONO_SEGUNDOS * 1000).toBeGreaterThan(FUNCION_ASINCRONA_MAX_MS);
    expect(LEASE_RAFAGA_SEGUNDOS).toBe(45);
    const f = buildRestaurantFixture();
    const leases: number[] = [];
    const original = f.repo.claimWhatsAppConversation.bind(f.repo);
    vi.spyOn(f.repo, "claimWhatsAppConversation").mockImplementation(async (o, h, m, s) => {
      leases.push(s);
      return original(o, h, m, s);
    });
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.l1", phone: "+5219990000001", body: "Hola", leaseSegundos: LEASE_TURNO_ASINCRONO_SEGUNDOS });
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.l2", phone: "+5219990000002", body: "Hola" });
    expect(leases).toEqual([LEASE_TURNO_ASINCRONO_SEGUNDOS, LEASE_RAFAGA_SEGUNDOS]);
  });
});
