// QA adversarial citas, ronda 1 (lente CAOS): el proveedor de LLM se cae A MEDIO TURNO de WhatsApp, despues de que una herramienta ya
// modifico la agenda. LLM GUIONADO sobre el LlmGateway real (FakeLlmProvider, sin red). Repo en memoria.
// Convencion: `it.fails` = defecto vigente (afirma lo ESPERADO y hoy falla); `it` = control que hoy pasa. Id: QA-citas-R1-caos-14.
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createAppointment, queryAvailability } from "../src/appointments.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";

const PHONE = "9981234567";
const PHONE_WA = "+5219981234567";
const customerCtx = { isNew: false, fullName: "María López", upcomingAppointments: [] } as const;

function toolTurn(id: string, name: string, args: Record<string, unknown>): LlmCompletionResult {
  return { text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
}

/** Guion: los pasos dados y, al acabarse, el proveedor (y su escalera) se cae. */
function handlerQueSeCae(fixture: ReturnType<typeof buildCitasFixture>, pasos: ((req: LlmCompletionRequest) => LlmCompletionResult)[]) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  let paso = 0;
  const guion = (req: LlmCompletionRequest): LlmCompletionResult => {
    const f = pasos[paso++];
    if (!f) throw new Error("proveedor caido (503)");
    return f(req);
  };
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: guion })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: guion })]);
  return createLlmWhatsAppTurnHandler(fixture.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}

async function citaExistente(fixture: ReturnType<typeof buildCitasFixture>) {
  const startsAt = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 2), "10:00", "America/Merida").toISOString();
  return createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María López", customerPhone: PHONE, startsAt, source: "whatsapp" });
}

describe("QA R1 caos citas -- LLM caido a medio turno", () => {
  it("control: crear_cita se guardo y el LLM se cae al redactar -> la cita existe y el paciente recibe una confirmacion honesta", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 3), "11:00", "America/Merida").toISOString();
    const handler = handlerQueSeCae(fixture, [() => toolTurn("c1", "crear_cita", { provider_id: fixture.providerId, service_id: fixture.serviceId, customer_name: "María López", starts_at: startsAt })]);
    const r = await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "agéndame el jueves a las 11" }], customer: customerCtx });
    expect(r.appointmentId).toBeTruthy();
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, r.appointmentId!))?.status).toBe("pending");
    expect(r.reply).toMatch(/registrada/);
  });

  it("control: el LLM se cae ANTES de cualquier herramienta -> aviso de problema tecnico, sin tocar la agenda", async () => {
    const fixture = buildCitasFixture();
    const apt = await citaExistente(fixture);
    const handler = handlerQueSeCae(fixture, []);
    const r = await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "cancela mi cita" }], customer: customerCtx });
    expect(r.reply).toMatch(/problema técnico/);
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("pending");
  });

  it("QA-citas-R1-caos-14: cancelar_cita se aplico y el LLM se cae -> el paciente NO debe leer 'Tu cita ya quedó registrada'", async () => {
    const fixture = buildCitasFixture();
    const apt = await citaExistente(fixture);
    const handler = handlerQueSeCae(fixture, [() => toolTurn("c1", "buscar_mis_citas", {}), () => toolTurn("c2", "cancelar_cita", { appointment_id: apt.id })]);
    const r = await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "cancela mi cita del martes porfa" }], customer: customerCtx });
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.status).toBe("cancelled");
    // Actual: providerFailureReply(appointmentId) = "¡Listo! Tu cita ya quedó registrada." (lo opuesto a lo que paso).
    expect(r.reply).not.toMatch(/registrada/);
    expect(r.reply).toMatch(/cancel/i);
  });

  it("QA-citas-R1-caos-14b: reagendar_cita se aplico y el LLM se cae -> el aviso menciona el cambio (no 'registrada' a secas)", async () => {
    const fixture = buildCitasFixture();
    const apt = await citaExistente(fixture);
    const nuevo = zonedTimeToUtc(nextWeekdayDateStr(new Date(), 2), "12:00", "America/Merida").toISOString();
    const handler = handlerQueSeCae(fixture, [() => toolTurn("c1", "buscar_mis_citas", {}), () => toolTurn("c2", "reagendar_cita", { appointment_id: apt.id, new_starts_at: nuevo })]);
    const r = await handler.handleInboundMessage({ organizationId: fixture.organizationId, phone: PHONE_WA, messages: [{ role: "user", content: "muévela a las 12" }], customer: customerCtx });
    expect((await fixture.repo.findAppointmentForOrganization(fixture.organizationId, apt.id))?.startsAt).toBe(nuevo);
    expect(r.reply).toMatch(/cambi|reagend|mov/i);
  });
});

describe("QA R1 caos citas -- fechas limite y horario de verano", () => {
  function clinicaEn(zona: string) {
    const repo = new InMemoryCitasRepository();
    const f = buildCitasFixture(repo);
    repo.seedOrganization({ id: f.organizationId, slug: "clinica-dental-sonrisas", name: "Clínica Dental Sonrisas", defaultTimezone: zona });
    return f;
  }

  it("control: Tijuana (con horario de verano) -- el primer horario del sabado/domingo/lunes del cambio de marzo 2027 sale a las 09:00 locales", async () => {
    const f = clinicaEn("America/Tijuana");
    // Viernes 12 (PST, UTC-8) y lunes 15 (PDT, UTC-7): el cambio fue el domingo 14.
    const viernes = await queryAvailability(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, dateStr: "2027-03-12" });
    const lunes = await queryAvailability(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, dateStr: "2027-03-15" });
    expect(viernes.slots[0]?.startsAt).toBe("2027-03-12T17:00:00.000Z");
    expect(lunes.slots[0]?.startsAt).toBe("2027-03-15T16:00:00.000Z");
    expect(viernes.slots).toHaveLength(lunes.slots.length);
  });

  it("control: 29 de febrero bisiesto y fin de anio -- fechas validas responden; 2027-02-29 es rechazado", async () => {
    const f = clinicaEn("America/Merida");
    const bisiesto = await queryAvailability(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, dateStr: "2028-02-29" });
    expect(bisiesto.slots[0]?.startsAt).toBe("2028-02-29T15:00:00.000Z");
    const finDeAnio = await queryAvailability(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, dateStr: "2027-12-31" });
    expect(finDeAnio.slots.at(-1)?.endsAt).toBe("2027-12-31T23:00:00.000Z");
    await expect(queryAvailability(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, dateStr: "2027-02-29" })).rejects.toThrow(/date/);
  });
});
