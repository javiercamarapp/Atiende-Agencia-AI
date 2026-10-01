// C-03 -- (1) herramienta `modificar_cita` en el agente de WhatsApp (cambia proveedor
// y/o servicio SIN tocar el horario, conserva el id) y (2) `tool_choice` forzado a
// `buscar_mis_citas` en el primer llamado cuando el cliente cancela con urgencia
// explícita. Además la guardia de titularidad de las tools que reciben un
// `appointment_id` redactado por el modelo (cancelar/reagendar/modificar).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { createLlmWhatsAppTurnHandler, TOOLS } from "../src/whatsapp/llm-turn-handler.ts";
import { isUrgentCancellationMessage } from "../src/whatsapp/urgent-cancellation.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";

const PHONE = "9981234567";
const PHONE_WA = "+5219981234567";

function toolTurn(id: string, name: string, args: Record<string, unknown>): LlmCompletionResult {
  return { text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
}
const text = (t: string): LlmCompletionResult => ({ text: t, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

function lastToolResult(request: LlmCompletionRequest): Record<string, unknown> {
  const msg = [...request.messages].reverse().find((m) => m.role === "tool");
  if (!msg || msg.role !== "tool") throw new Error("se esperaba un mensaje tool previo");
  return JSON.parse(msg.content) as Record<string, unknown>;
}

function buildHandler(fixture: ReturnType<typeof buildCitasFixture>, script: (request: LlmCompletionRequest, step: number) => LlmCompletionResult, requests: LlmCompletionRequest[] = [], roles: string[] = []) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  let step = 0;
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: (req) => { requests.push(req); roles.push("default"); return script(req, step++); } })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: (req) => { requests.push(req); roles.push("escalated"); return script(req, step++); } })]);
  return createLlmWhatsAppTurnHandler(fixture.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}

const customerCtx = { isNew: false, fullName: "María López", upcomingAppointments: [] } as const;

async function book(fixture: ReturnType<typeof buildCitasFixture>, phone = PHONE) {
  const startsAt = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 2), "10:00", "America/Merida").toISOString();
  return createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María López", customerPhone: phone, startsAt, source: "whatsapp" });
}

/** Segundo proveedor que también ofrece el servicio, con el mismo horario L-V 9-17. */
function addSecondProvider(fixture: ReturnType<typeof buildCitasFixture>, withAvailability: boolean): string {
  const id = randomUUID();
  fixture.repo.seedProvider({ id, organizationId: fixture.organizationId, propertyId: null, displayName: "Dr. Mateo Pérez", roleLabel: "Dentista", isActive: true });
  fixture.repo.seedProviderService(id, fixture.serviceId);
  if (withAvailability) {
    for (const dayOfWeek of [1, 2, 3, 4, 5]) fixture.repo.seedAvailabilityRule({ id: randomUUID(), providerId: id, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
  }
  return id;
}

describe("modificar_cita (C-03)", () => {
  it("la herramienta está registrada con appointment_id obligatorio y new_provider_id/new_service_id opcionales", () => {
    const tool = TOOLS.find((t) => t.name === "modificar_cita");
    expect(tool).toBeDefined();
    expect((tool!.parameters as { required: string[] }).required).toEqual(["appointment_id"]);
    expect(Object.keys((tool!.parameters as { properties: object }).properties)).toEqual(["appointment_id", "new_provider_id", "new_service_id"]);
  });

  it("cambia el proveedor SIN tocar el horario y conserva el mismo appointment_id", async () => {
    const fixture = buildCitasFixture();
    const apt = await book(fixture);
    const newProviderId = addSecondProvider(fixture, true);
    let toolResult: Record<string, unknown> = {};
    const handler = buildHandler(fixture, (request, step) => {
      if (step === 0) return toolTurn("c1", "modificar_cita", { appointment_id: apt.id, new_provider_id: newProviderId });
      toolResult = lastToolResult(request);
      return text("Listo, cambié tu cita de proveedor.");
    });

    const result = await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "quiero cambiar de doctor" }], customer: customerCtx });

    const after = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id);
    expect(after?.providerId).toBe(newProviderId);
    expect(after?.startsAt).toBe(apt.startsAt);
    expect(after?.id).toBe(apt.id);
    expect((toolResult.appointment as { appointment_id: string }).appointment_id).toBe(apt.id);
    expect(result.appointmentId).toBe(apt.id);
  });

  it("un proveedor sin disponibilidad a esa hora responde error con alternative_slots (nunca cambia la cita) y escala el modelo en el siguiente turno", async () => {
    const fixture = buildCitasFixture();
    const apt = await book(fixture);
    const sinHorario = addSecondProvider(fixture, false);
    const roles: string[] = [];
    let toolResult: Record<string, unknown> = {};
    const handler = buildHandler(
      fixture,
      (request, step) => {
        if (step === 0) return toolTurn("c1", "modificar_cita", { appointment_id: apt.id, new_provider_id: sinHorario });
        toolResult = lastToolResult(request);
        return text("Ese doctor no tiene ese horario.");
      },
      [],
      roles,
    );

    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "cámbiame de doctor" }], customer: customerCtx });

    expect(typeof toolResult.error).toBe("string");
    expect(Array.isArray(toolResult.alternative_slots)).toBe(true);
    // un fallo real de modificar_cita escala al modelo caro en el llamado siguiente del turno
    expect(roles).toEqual(["default", "escalated"]);
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.providerId).toBe(fixture.providerId);
  });

  it("modificar sin ningún cambio real (mismo proveedor y servicio) devuelve error de validación, no lanza", async () => {
    const fixture = buildCitasFixture();
    const apt = await book(fixture);
    let toolResult: Record<string, unknown> = {};
    const handler = buildHandler(fixture, (request, step) => {
      if (step === 0) return toolTurn("c1", "modificar_cita", { appointment_id: apt.id, new_provider_id: fixture.providerId });
      toolResult = lastToolResult(request);
      return text("No hay cambios.");
    });
    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "x" }], customer: customerCtx });
    expect(String(toolResult.error)).toContain("ningún cambio");
  });
});

describe("guardia de titularidad de las tools con appointment_id redactado por el modelo", () => {
  it("modificar_cita / cancelar_cita / reagendar_cita sobre la cita de OTRO cliente responden 'Cita no encontrada' y no cambian nada", async () => {
    const fixture = buildCitasFixture();
    const ajena = await book(fixture, "9987654321"); // cliente distinto del remitente
    const newProviderId = addSecondProvider(fixture, true);
    const results: Record<string, unknown>[] = [];
    const calls: [string, Record<string, unknown>][] = [
      ["modificar_cita", { appointment_id: ajena.id, new_provider_id: newProviderId }],
      ["cancelar_cita", { appointment_id: ajena.id }],
      ["reagendar_cita", { appointment_id: ajena.id, new_starts_at: new Date(Date.parse(ajena.startsAt) + 3_600_000).toISOString() }],
    ];
    const handler = buildHandler(fixture, (request, step) => {
      if (step > 0) results.push(lastToolResult(request));
      const next = calls[step];
      return next ? toolTurn(`c${step}`, next[0], next[1]) : text("listo");
    });

    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "x" }], customer: customerCtx });

    expect(results.map((r) => r.error)).toEqual(["Cita no encontrada", "Cita no encontrada", "Cita no encontrada"]);
    const after = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, ajena.id);
    expect(after).toMatchObject({ status: "pending", providerId: fixture.providerId, startsAt: ajena.startsAt });
  });

  it("un appointment_id que no es UUID (texto inventado por el modelo) nunca llega a la base: 'Cita no encontrada'", async () => {
    const fixture = buildCitasFixture();
    await book(fixture);
    let toolResult: Record<string, unknown> = {};
    const handler = buildHandler(fixture, (request, step) => {
      if (step === 0) return toolTurn("c1", "cancelar_cita", { appointment_id: "la-primera-cita" });
      toolResult = lastToolResult(request);
      return text("no encontré");
    });
    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "x" }], customer: customerCtx });
    expect(toolResult.error).toBe("Cita no encontrada");
  });

  it("control: el titular SÍ puede cancelar su propia cita con la tool", async () => {
    const fixture = buildCitasFixture();
    const propia = await book(fixture);
    const handler = buildHandler(fixture, (_request, step) => (step === 0 ? toolTurn("c1", "cancelar_cita", { appointment_id: propia.id }) : text("cancelada")));
    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "cancela" }], customer: customerCtx });
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, propia.id))?.status).toBe("cancelled");
  });
});

describe("cancelación urgente -> tool_choice forzado (C-03)", () => {
  async function run(userMessage: string) {
    const fixture = buildCitasFixture();
    const requests: LlmCompletionRequest[] = [];
    const handler = buildHandler(
      fixture,
      (_request, step) => (step === 0 ? toolTurn("c1", "buscar_mis_citas", {}) : text("¿Cuál cita quieres cancelar?")),
      requests,
    );
    await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: userMessage }], customer: customerCtx });
    return requests;
  }

  it("urgencia + cancelar: el PRIMER llamado fuerza buscar_mis_citas y los siguientes del mismo turno NO", async () => {
    const requests = await run("URGENTE, ya no voy a poder llegar, cancela mi cita");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[0]!.toolChoice).toEqual({ name: "buscar_mis_citas" });
    expect(requests[1]!.toolChoice).toBeUndefined();
  });

  it("cancelar a secas (sin urgencia) NO fuerza nada", async () => {
    const requests = await run("quiero cancelar mi cita del jueves");
    expect(requests[0]!.toolChoice).toBeUndefined();
  });

  it("urgencia sin intención de cancelar NO fuerza nada", async () => {
    const requests = await run("es urgente que me confirmen el horario");
    expect(requests[0]!.toolChoice).toBeUndefined();
  });

  it("solo cuenta el ÚLTIMO mensaje del cliente, no uno anterior de la conversación", async () => {
    const fixture = buildCitasFixture();
    const requests: LlmCompletionRequest[] = [];
    const handler = buildHandler(fixture, () => text("ok"), requests);
    await handler.handleInboundMessage({
      organizationId: fixture.organizationId,
      phone: PHONE_WA,
      messages: [
        { role: "user", content: "urgente cancela mi cita" },
        { role: "assistant", content: "¿cuál?" },
        { role: "user", content: "la del jueves" },
      ],
      customer: customerCtx,
    });
    expect(requests[0]!.toolChoice).toBeUndefined();
  });
});

describe("isUrgentCancellationMessage", () => {
  it.each([
    ["urgente, ya no voy a poder llegar, cancela mi cita", true],
    ["Cancelen mi cita ahora mismo", true],
    ["necesito anular mi cita lo antes posible", true],
    ["URGENCIA: no voy a poder ir", true],
    ["ya no puedo ir, es una emergencia", true],
    ["quiero cancelar mi cita", false],
    ["cancela mi cita para el jueves", false],
    ["es urgente que me atiendan", false],
    ["estoy urgido de que me confirmen", false],
    ["hola", false],
    ["", false],
  ])("%j -> %s", (message, expected) => {
    expect(isUrgentCancellationMessage(message)).toBe(expected);
  });
});
