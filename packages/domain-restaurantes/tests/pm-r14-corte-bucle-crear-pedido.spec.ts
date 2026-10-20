// PM ronda 14 (hallazgo H2): confirmar_resumen ok -> crear_pedido error_regla -> buscar_producto x7 hasta agotar el reloj de 18 s. El servidor ya rechaza el pedido
// (es su trabajo); lo que sobraba era dejar que el modelo reintentara hasta vencer el turno y el cliente se quedara sin respuesta util. Tras DOS rechazos de regla
// de crear_pedido en el mismo turno el turno corta y le responde al cliente con el resumen canonico (o un mensaje fijo) para que confirme o corrija.
// LLM falso guionado, sin red ni llaves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { CIERRE_MAQUINA_ENV } from "../src/agent-tools/cierre-maquina.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_COPY } from "../src/whatsapp/perfil-pm.ts";
import type { EventoObservabilidadWhatsApp, EventoTurnoWhatsApp } from "../src/whatsapp/observabilidad-turno.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
const PHONE = "+5219990001111";
const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };

beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
  vi.stubEnv(CIERRE_MAQUINA_ENV, "1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

async function mundo(guion: (paso: number, f: ReturnType<typeof buildRestaurantFixture>, req: LlmCompletionRequest) => LlmCompletionResult) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  let llamadas = 0;
  const provider = new FakeLlmProvider({ id: "guion", script: (request: LlmCompletionRequest) => guion((llamadas += 1), f, request) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "escalado-sin-uso" })]);
  const eventos: EventoObservabilidadWhatsApp[] = [];
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", observabilidad: { emitir: (e) => void eventos.push(e) } });
  const turno = () => handler.handleInboundMessage({ organizationId: f.organizationId, phone: PHONE, messages: [{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }], customer: { isNew: true as const }, propertyId: null });
  const evento = () => eventos.find((e): e is EventoTurnoWhatsApp => e.evento === "whatsapp_turno")!;
  return { f, turno, evento, llamadas: () => llamadas };
}

const cotiza = (f: { products: { cocaCola: string } }, id = "c1") =>
  llamada(id, "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
// crear_pedido en el mismo turno que la cotizacion: el servidor lo rechaza por regla (el cliente aun no confirmo).
const crea = (f: { products: { cocaCola: string } }, id: string) =>
  llamada(id, "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", payment_method: "efectivo", efectivo_con: 500, items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
const busca = (id: string) => llamada(id, "buscar_producto", { query: "coca" });

describe("corte del bucle crear_pedido bloqueado -> buscar_producto", () => {
  it("con la maquina de cierre ON: al SEGUNDO error_regla de crear_pedido el turno termina con el resumen canonico, sin escalar ni crear pedido", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return busca("b1");
      if (paso === 4) return crea(f, "k2");
      return busca(`b${paso}`); // el modelo seguiria buscando hasta agotar el reloj
    });
    const t = await m.turno();
    expect(m.llamadas()).toBeLessThanOrEqual(4);
    expect(m.evento().vueltas).toBeLessThanOrEqual(4);
    expect(m.evento().tools.map((x) => x.tool)).toEqual(["cotizar_pedido", "crear_pedido", "buscar_producto", "crear_pedido"]);
    expect(m.evento().tools.filter((x) => x.tool === "crear_pedido").map((x) => x.resultado)).toEqual(["error_regla", "error_regla"]);
    expect(m.evento().resultado).toBe("ok");
    expect(t.reply).toContain("Total a pagar: $");
    expect(t.reply).toMatch(/¿Está correcto\? Responda \*sí\*/);
    expect(t.orderId ?? null).toBeNull();
    expect((t as { escalacion?: unknown }).escalacion).toBeUndefined();
  });

  it("con la maquina de cierre OFF (sin resumen canonico): el mismo corte con el mensaje fijo que pide confirmar o corregir", async () => {
    vi.stubEnv(CIERRE_MAQUINA_ENV, "");
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return busca("b1");
      if (paso === 4) return crea(f, "k2");
      return busca(`b${paso}`);
    });
    const t = await m.turno();
    expect(m.llamadas()).toBeLessThanOrEqual(4);
    expect(m.evento().resultado).toBe("ok");
    expect(t.reply).toBe(PM_COPY.cierreBloqueado);
    expect(t.orderId ?? null).toBeNull();
    expect((t as { escalacion?: unknown }).escalacion).toBeUndefined();
  });

  it("un solo rechazo de regla no corta: el modelo explica con su texto", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f);
      if (paso === 2) return crea(f, "k1");
      return texto("Aun necesito su confirmacion para registrar el pedido.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(3);
    expect(t.reply).toContain("Aun necesito su confirmacion");
    expect(t.reply).not.toBe(PM_COPY.cierreBloqueado);
  });

  it("dos rechazos NO consecutivos (una cotizacion nueva exitosa en medio) no cortan", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cotiza(f, "c1");
      if (paso === 2) return crea(f, "k1");
      if (paso === 3) return cotiza(f, "c2");
      if (paso === 4) return crea(f, "k2");
      return texto("Revisemos el pedido otra vez, por favor.");
    });
    const t = await m.turno();
    expect(m.llamadas()).toBe(5);
    expect(t.reply).toContain("Revisemos el pedido otra vez");
  });
});
