// QA restaurantes, ronda 1, lente CAOS (3-oct-2026): el turno del agente de WhatsApp cuando el proveedor de LLM esta LENTO.
// LLM simulado por guion (FakeLlmProvider con espera), repositorio en memoria y reloj falso: sin red ni base real.
// Regresion de QA-restaurantes-R1-caos-15 (el turno cabe en la vida de la funcion del webhook).
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { FUNCION_MAX_MS, MARGEN_CIERRE_TURNO_MS, recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
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
      // El modelo sigue encadenando herramientas (consultar sucursal, buscar producto...) como en un pedido de PM con varios renglones.
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

describe("caos WhatsApp: LLM lento contra la vida de la funcion del webhook", () => {
  // QA-restaurantes-R1-caos-15: el turno corre DENTRO de la funcion del webhook (maxDuration 30 s en vercel.json, FUNCION_MAX_MS), pero
  // el presupuesto del turno es 45 s (turnBudgetMs por omision; produccion no lo cambia) y el perfil PM permite 8 vueltas de LLM. Con un
  // proveedor a ~4 s por llamada (hora pico) el turno dura ~32 s: Vercel mata la funcion antes de confirmar la transaccion del webhook,
  // el cliente se queda sin respuesta y Meta reintenta todo el lote (con el pedido y la comanda del turno interno ya hechos).
  it("QA-caos-15: con el LLM a 4 s por llamada el turno termina con margen dentro de los 30 s de la funcion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = buildRestaurantFixture();
    const { gateway, provider } = gatewayLento(4_000);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    // Perfil PM (8 vueltas de herramientas).
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const inicio = Date.now();
    let fin: number | null = null;
    const turno = handler
      .handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990002222", messages: [{ role: "user", content: "medio de pastor, uno de bistec, 3 cocas y 2 de suadero para recoger" }], customer: { isNew: true }, propertyId: null })
      .then((r) => {
        fin = Date.now();
        return r;
      });
    for (let i = 0; i < 120 && fin === null; i++) await vi.advanceTimersByTimeAsync(1_000);
    const r = await turno;
    expect(r.reply.length).toBeGreaterThan(0);
    expect(provider.callCount).toBeGreaterThan(1);
    // Margen de 5 s para confirmar la transaccion, encolar la respuesta y despachar inline.
    expect(fin! - inicio).toBeLessThan(FUNCION_MAX_MS - 5_000);
  });

  it("PASA: con el LLM sano (300 ms) el mismo turno de varias herramientas cabe holgado en la funcion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = buildRestaurantFixture();
    const { gateway } = gatewayLento(300);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    const inicio = Date.now();
    let fin: number | null = null;
    const turno = handler
      .handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990003333", messages: [{ role: "user", content: "dos cocas para recoger" }], customer: { isNew: true }, propertyId: null })
      .then((r) => {
        fin = Date.now();
        return r;
      });
    for (let i = 0; i < 600 && fin === null; i++) await vi.advanceTimersByTimeAsync(100);
    await turno;
    expect(fin! - inicio).toBeLessThan(FUNCION_MAX_MS - 5_000);
  });

  it("con finTurnoMs (lo manda el webhook tras la espera de la rafaga) el turno termina antes de ese instante, aunque el presupuesto propio sea mayor", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = buildRestaurantFixture();
    const { gateway } = gatewayLento(4_000);
    const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo", deliveryTimeText: "de 40 a 50 minutos" });
    const inicio = Date.now();
    let fin: number | null = null;
    const turno = handler
      .handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990004444", messages: [{ role: "user", content: "medio de pastor para recoger" }], customer: { isNew: true }, propertyId: null, finTurnoMs: inicio + 9_000 })
      .then((r) => {
        fin = Date.now();
        return r;
      });
    for (let i = 0; i < 120 && fin === null; i++) await vi.advanceTimersByTimeAsync(1_000);
    const r = await turno;
    expect(r.reply.length).toBeGreaterThan(0);
    // 3 llamadas de 4 s: la tercera arranca a los 8 s (< 9) y termina a los 12; ninguna mas arranca despues del tope.
    expect(fin! - inicio).toBeLessThanOrEqual(12_000);
  });
});

describe("caos-15: la fase B le pasa al agente el fin de su turno (fin de la funcion menos el margen de cierre)", () => {
  it("responderTrasEspera manda finTurnoMs = finFuncionMs - MARGEN_CIERRE_TURNO_MS; sin finFuncionMs no manda nada", async () => {
    const f = buildRestaurantFixture();
    const vistos: Array<number | undefined> = [];
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage({ finTurnoMs }) {
        vistos.push(finTurnoMs);
        return { reply: "ok", orderId: null, propertyId: null };
      },
    };
    const tel = "+5219991234567";
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.f1", phone: tel, body: "Hola" });
    await responderTrasEspera(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.f1", phone: tel, phoneNumberId: "123", finFuncionMs: 1_000_000 });
    await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: "wamid.f2", phone: tel, body: "Otro" });
    await responderTrasEspera(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.f2", phone: tel, phoneNumberId: "123" });
    expect(vistos).toEqual([1_000_000 - MARGEN_CIERRE_TURNO_MS, undefined]);
  });
});
