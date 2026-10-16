// Correccion de la revision de #467: hora de recogida en la huella del pedido, tope de reparto por perfil, escalacion informativa que NO congela el pedido (whatsapp-05,
// de punta a punta por inbound + toma de handoff) y guardia de "de cortesia" sin promocion aplicada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { fingerprintOrder, resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { assignBranch, RADIO_REPARTO_PM_KM } from "../src/branch-assignment.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { quitarCortesiaNoRespaldada } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const MARTES_13 = new Date("2026-10-06T13:00:00-06:00");
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MARTES_13);
});
afterEach(() => vi.useRealTimers());

describe("hora_recogida dentro de la huella del pedido", () => {
  const items = [{ productId: "p1", requestedQuantity: 2 }];
  it("la huella cambia con la hora y no cambia sin ella (los pedidos sin hora conservan su huella)", () => {
    const base = { branchSlug: "s", canal: "recoger", items };
    expect(fingerprintOrder({ ...base, horaRecogida: "2026-10-06T20:00" })).not.toBe(fingerprintOrder(base));
    expect(fingerprintOrder({ ...base, horaRecogida: "2026-10-06T20:00" })).not.toBe(fingerprintOrder({ ...base, horaRecogida: "2026-10-06T20:30" }));
    expect(fingerprintOrder({ ...base, horaRecogida: undefined })).toBe(fingerprintOrder(base));
  });

  function setup() {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", flow: { key: "k:hora", turn: String(turn), now: () => Date.now() } });
    const base = { branch_slug: "fco-montejo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], canal: "recoger" };
    return {
      quote: (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, ...extra }),
      confirm: () => invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {}),
      create: (extra: Record<string, unknown> = {}) => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, customer_name: "Nora", payment_method: "efectivo", ...extra }),
      next: () => void (turn += 1),
    };
  }

  it("cotizada con una hora, crear con OTRA hora exige re-cotizar", async () => {
    const s = setup();
    await s.quote({ hora_recogida: "2026-10-06T14:00:00-06:00" });
    s.next();
    await s.confirm();
    await expect(s.create({ hora_recogida: "2026-10-06T15:30:00-06:00" })).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
  });
  it("la misma hora (aunque cambie el offset) o sin repetirla al crear, cierra el pedido", async () => {
    const a = setup();
    await a.quote({ hora_recogida: "2026-10-06T14:00:00-06:00" });
    a.next();
    await a.confirm();
    expect((await a.create({ hora_recogida: "2026-10-06T20:00:00Z" })).orderId).not.toBeNull();
    const b = setup();
    await b.quote({ hora_recogida: "2026-10-06T14:00:00-06:00" });
    b.next();
    await b.confirm();
    expect((await b.create()).orderId).not.toBeNull();
  });
  it("cotizada SIN hora, una hora agregada al crear (la valida el servidor) no rompe el cierre", async () => {
    const s = setup();
    await s.quote();
    s.next();
    await s.confirm();
    expect((await s.create({ hora_recogida: "2026-10-06T14:30:00-06:00" })).orderId).not.toBeNull();
  });
});

describe("tope duro de reparto por perfil (buscar_sucursal_cercana)", () => {
  const PROGRESO = { lat: 21.2817, lng: -89.665 }; // ~28 km de las sucursales de la fixture
  const ctx = (organizationId: string) => ({ organizationId, channel: "whatsapp" as const, phone: "9991234567" });
  it("perfil taqueria_pm: 8 km duros aunque el modelo mande max_km 500", async () => {
    const f = buildRestaurantFixture();
    await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const r = await invokeAgentTool(f.repo, ctx(f.organizationId), "buscar_sucursal_cercana", { ...PROGRESO, max_km: 500 });
    expect(r.result).toMatchObject({ encontrada: false, estado: "fuera_de_zona", max_km: RADIO_REPARTO_PM_KM });
  });
  it("perfil generico (o sin configuracion): no hereda el tope de PM", async () => {
    const f = buildRestaurantFixture();
    const r = await invokeAgentTool(f.repo, ctx(f.organizationId), "buscar_sucursal_cercana", { ...PROGRESO });
    expect(r.result).toMatchObject({ encontrada: true, estado: "asignada" });
  });
  it("assignBranch: radioMaximoKm null = sin tope duro, un numero lo fija y el modelo solo puede bajarlo", async () => {
    const f = buildRestaurantFixture();
    const sin = await assignBranch(f.repo, { organizationId: f.organizationId, ...PROGRESO, radioMaximoKm: null });
    expect(sin.estado).toBe("asignada");
    const con = await assignBranch(f.repo, { organizationId: f.organizationId, ...PROGRESO, radioMaximoKm: 10, maxKm: 500 });
    expect(con).toMatchObject({ estado: "fuera_de_zona", maxKm: 10 });
  });
});

describe("escalacion informativa NO congela el pedido (whatsapp-05, de punta a punta)", () => {
  it("producto_agotado/reposicion_descuento: no se abre toma y el SIGUIENTE mensaje del cliente lo contesta el agente", async () => {
    const f = buildRestaurantFixture();
    const store = new InMemoryConversacionesRepository({ actorUserId: "00000000-0000-4000-8000-0000000000f1" });
    const gate = new InMemoryHandoffAgentGate(store);
    const PHONE = "+5219991234567";
    const propertyId = "00000000-0000-4000-8000-0000000000a1";
    store.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: f.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    let motivo = "reposicion_descuento";
    let turnos = 0;
    const handler = {
      async handleInboundMessage() {
        turnos += 1;
        return { reply: turnos === 1 ? "Ya avisé al gerente; mientras tanto, ¿lo dejamos en 2 tacos?" : "Listo, su pedido sigue en curso.", orderId: null, propertyId: null, ...(turnos === 1 ? { escalacion: { motivo } } : {}) };
      },
    };
    const enviar = (id: string, body: string) => handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: id, phone: PHONE, body, phoneNumberId: "1", propertyId, handoffGate: gate });
    const primera = await enviar("w5-1", "¿me hacen descuento?");
    expect(primera).toMatchObject({ ok: true, escalated: false });
    expect(store.handoffs).toHaveLength(0);
    const segunda = await enviar("w5-2", "sí, 2 tacos");
    expect(segunda).toMatchObject({ ok: true, reply: "Listo, su pedido sigue en curso." });
    expect(turnos).toBe(2);
    // Contraste: un motivo de seguridad (queja) SI abre la toma y el agente calla.
    motivo = "queja";
    turnos = 0;
    await enviar("w5-3", "me llegó mal");
    expect(store.handoffs.some((h) => h.estado === "pendiente" && h.motivo === "queja")).toBe(true);
  });
});

describe("'de cortesia' solo si cotizar_pedido devolvio promocion_aplicada (H13)", () => {
  it("quitarCortesiaNoRespaldada quita la afirmacion y deja las explicaciones de la regla", () => {
    expect(quitarCortesiaNoRespaldada("Su total es de $126. Incluye 2 aguas de cortesía. ¿Algo más?")).toBe("Su total es de $126. ¿Algo más?");
    expect(quitarCortesiaNoRespaldada("El combo con aguas de cortesía aplica solo para recoger los martes.")).toContain("cortesía");
    expect(quitarCortesiaNoRespaldada("Con media orden no hay aguas de cortesía.")).toContain("cortesía");
    expect(quitarCortesiaNoRespaldada("Sus aguas son de cortesía.")).toMatch(/ninguna promoción/);
    expect(quitarCortesiaNoRespaldada("Total $126.")).toBe("Total $126.");
  });

  type Script = (request: LlmCompletionRequest) => LlmCompletionResult;
  const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
  const llamada = (id: string, name: string, args: object): LlmCompletionResult => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
  function handlerGuionado(repo: ReturnType<typeof buildRestaurantFixture>["repo"], script: Script) {
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
    return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  }

  it("el modelo cotiza (sin promocion) y dice 'de cortesia': el cliente no lo lee", async () => {
    const f = buildRestaurantFixture();
    let paso = 0;
    const handler = handlerGuionado(f.repo, () => {
      paso += 1;
      if (paso === 1) return llamada("c1", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] });
      return texto("Permítame repetirle su pedido: 2 Coca-Cola. Incluye una agua de cortesía. ¿Es correcto?");
    });
    const out = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990001111", messages: [{ role: "user", content: "2 coca colas para recoger" }], customer: { isNew: true }, propertyId: null });
    expect(out.reply).toContain("2 Coca-Cola");
    expect(out.reply).not.toMatch(/cortes[ií]a/i);
  });
});
