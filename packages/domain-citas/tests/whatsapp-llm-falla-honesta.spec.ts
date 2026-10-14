// Mensaje de falla honesto (mismo defecto que restaurantes #551/#552). Antes, cuando el modelo/proveedor fallaba:
//   - tras `cancelar_cita` exitoso el cliente leia "¡Listo! Tu cita ya quedó registrada." (falso: la cita se cancelo);
//   - sin cita decia "un momento por favor" / "intenta de nuevo" sin avisar a nadie.
// Ahora el respaldo nombra la accion que SI se hizo, y sin cita el turno pide una persona; `inbound` solo cambia a "ya avisé" si la solicitud quedo registrada.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/conversaciones/in-memory-repository.ts";
import { createDefaultConversationGuard, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { FALLA_CON_AVISO_REPLY, FALLA_SIN_AVISO_REPLY, createLlmWhatsAppTurnHandler, providerFailureReply } from "../src/whatsapp/llm-turn-handler.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";

const PHONE = "9981234567";
const PHONE_WA = "+5219981234567";
const customerCtx = { isNew: false, fullName: "María López", upcomingAppointments: [] } as const;

/** Lo que el cliente NO debe leer cuando el asistente fallo. */
const PROMESA_FALSA = /un momento por favor|ya qued[óo] registrada|¡listo!/i;
const toolTurn = (name: string, args: Record<string, unknown>): LlmCompletionResult => ({ text: "", toolCalls: [{ id: randomUUID(), name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

function handlerCon(fixture: ReturnType<typeof buildCitasFixture>, script: (step: number) => LlmCompletionResult, opts: { turnBudgetMs?: number; maxToolUseTurns?: number } = {}) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  let step = 0;
  const provider = () => new FakeLlmProvider({ id: "p", script: () => script(step++) });
  gateway.registerLadder("default", [provider()]);
  gateway.registerLadder("escalated", [provider()]);
  return createLlmWhatsAppTurnHandler(fixture.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...opts });
}
const proveedorCaido = (): never => {
  throw Object.assign(new Error("caído"), { status: 503 });
};
const entrada = (fixture: ReturnType<typeof buildCitasFixture>) => ({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user" as const, content: "quiero una cita" }], customer: customerCtx });

async function book(fixture: ReturnType<typeof buildCitasFixture>) {
  const startsAt = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 2), "10:00", "America/Merida").toISOString();
  return createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María López", customerPhone: PHONE, startsAt, source: "whatsapp" });
}

describe("providerFailureReply: nombra lo que SI se hizo", () => {
  it.each([
    ["crear_cita", /registrada/i],
    ["cancelar_cita", /cancelada/i],
    ["reagendar_cita", /actualizada/i],
    ["modificar_cita", /actualizada/i],
  ] as const)("con cita y accion %s", (accion, esperado) => {
    const texto = providerFailureReply("apt-1", accion);
    expect(texto).toMatch(esperado);
    // Nunca dice 'registrada' de una cita cancelada ni 'cancelada' de una registrada.
    if (accion !== "crear_cita") expect(texto).not.toMatch(/registrada/i);
    if (accion !== "cancelar_cita") expect(texto).not.toMatch(/cancelada/i);
  });

  it("sin cita (null, '' ) es la disculpa sin promesas, sea cual sea la accion", () => {
    for (const id of [null, ""]) for (const accion of ["crear_cita", "cancelar_cita"] as const) expect(providerFailureReply(id, accion)).toBe(FALLA_SIN_AVISO_REPLY);
    expect(FALLA_SIN_AVISO_REPLY).not.toMatch(/avis[ée]|contacte|un momento por favor/i);
  });
});

describe("turno del agente cuando falla", () => {
  it("tras cancelar_cita exitoso y caer el proveedor, el cliente lee que se CANCELO (no 'registrada')", async () => {
    const fixture = buildCitasFixture();
    const apt = await book(fixture);
    const handler = handlerCon(fixture, (step) => (step === 0 ? toolTurn("cancelar_cita", { appointment_id: apt.id }) : proveedorCaido()));
    const r = await handler.handleInboundMessage(entrada(fixture));
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("cancelled");
    expect(r.reply).toBe("Tu cita quedó cancelada.");
    expect(r.reply).not.toMatch(/registrada/i);
    expect(r.appointmentId).toBe(apt.id);
    expect(r.handoff).toBeUndefined();
  });

  it("proveedor caido sin cita: disculpa sin promesas y pide una persona", async () => {
    const fixture = buildCitasFixture();
    const r = await handlerCon(fixture, proveedorCaido).handleInboundMessage(entrada(fixture));
    expect(r.reply).toBe(FALLA_SIN_AVISO_REPLY);
    expect(r.reply).not.toMatch(PROMESA_FALSA);
    expect(r.appointmentId).toBeNull();
    expect(r.handoff?.replyConAviso).toBe(FALLA_CON_AVISO_REPLY);
    expect(r.handoff?.motivo).toMatch(/falla del sistema: error_proveedor/);
  });

  it("tiempo agotado (presupuesto 0) sin cita: mismo trato, motivo presupuesto_agotado", async () => {
    const fixture = buildCitasFixture();
    const r = await handlerCon(fixture, () => ({ text: "hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }), { turnBudgetMs: 0 }).handleInboundMessage(entrada(fixture));
    expect(r.reply).toBe(FALLA_SIN_AVISO_REPLY);
    expect(r.handoff?.motivo).toMatch(/presupuesto_agotado/);
  });

  it("vueltas agotadas sin cita: ya no deja 'un momento por favor' y pide una persona", async () => {
    const fixture = buildCitasFixture();
    const r = await handlerCon(fixture, () => toolTurn("listar_servicios", {}), { maxToolUseTurns: 2 }).handleInboundMessage(entrada(fixture));
    expect(r.reply).toBe(FALLA_SIN_AVISO_REPLY);
    expect(r.reply).not.toMatch(PROMESA_FALSA);
    expect(r.handoff?.motivo).toMatch(/loop_agotado/);
  });

  it("una respuesta normal del modelo no trae handoff ni texto de falla", async () => {
    const fixture = buildCitasFixture();
    const r = await handlerCon(fixture, () => ({ text: "¿Qué día te gustaría?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 })).handleInboundMessage(entrada(fixture));
    expect(r.reply).toBe("¿Qué día te gustaría?");
    expect(r.handoff).toBeUndefined();
  });
});

describe("inbound: 'ya avisé' solo si la solicitud de humano quedo registrada", () => {
  function montar(opciones: { conConversacion: boolean; baseSinMigrar?: boolean; sinPuerto?: boolean }) {
    const fixture = buildCitasFixture();
    const store = new InMemoryConversacionesRepository({ actorUserId: randomUUID(), nombres: {} });
    const gate = new InMemoryHandoffAgentGate(store);
    if (opciones.conConversacion) store.conversaciones.push({ id: randomUUID(), organizationId: fixture.organizationId, propertyId: null, telefono: PHONE_WA, mensajes: [{ rol: "cliente", texto: "Hola" }], actividadAt: new Date().toISOString() });
    store.organizacionesConNumero.add(fixture.organizationId);
    if (opciones.baseSinMigrar) store.disponible = false;
    const turnHandler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        return { reply: FALLA_SIN_AVISO_REPLY, appointmentId: null, propertyId: null, handoff: { motivo: "El asistente no pudo responder (falla del sistema: error_proveedor).", replyConAviso: FALLA_CON_AVISO_REPLY } };
      },
    };
    const entrante = () =>
      handleInboundWhatsAppMessage(fixture.repo, turnHandler, createDefaultConversationGuard({}), {
        organizationId: fixture.organizationId, messageId: `wamid-${randomUUID()}`, phone: PHONE_WA, body: "quiero una cita", phoneNumberId: "1234567890", ...(opciones.sinPuerto ? {} : { handoffGate: gate }),
      });
    const enOutbox = async () => (await fixture.repo.claimMessagingOutboxBatch(50, 60)).map((m) => (m.payload as { body?: string }).body);
    return { store, entrante, enOutbox };
  }

  it("con conversacion y base migrada: se abre el handoff pendiente y el cliente lee 'ya avisé' (en la respuesta y en el outbox)", async () => {
    const t = montar({ conConversacion: true });
    const r = await t.entrante();
    expect(r).toMatchObject({ ok: true, reply: FALLA_CON_AVISO_REPLY });
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toMatchObject({ estado: "pendiente", crisis: false });
    expect(await t.enOutbox()).toEqual([FALLA_CON_AVISO_REPLY]);
  });

  it.each([
    ["sin conversacion registrada (el puerto devuelve null)", { conConversacion: false }],
    ["base sin migrar", { conConversacion: true, baseSinMigrar: true }],
    ["sin puerto de handoff", { conConversacion: true, sinPuerto: true }],
  ])("%s: no se promete aviso", async (_nombre, opciones) => {
    const t = montar(opciones);
    const r = await t.entrante();
    expect(r).toMatchObject({ ok: true, reply: FALLA_SIN_AVISO_REPLY });
    expect(r.reply).not.toMatch(/avis[ée]/i);
    expect(t.store.handoffs).toHaveLength(0);
    expect(await t.enOutbox()).toEqual([FALLA_SIN_AVISO_REPLY]);
  });
});
