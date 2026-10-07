// QA citas R1 -- lente VIAJE COMPLETO: dos pacientes quieren EL MISMO horario al mismo tiempo (WhatsApp + voz + panel), y un mismo paciente
// manda dos mensajes casi simultaneos. Motor real de agenda en memoria; la carrera real contra Postgres la cubre
// scripts/verify-citas-concurrencia (corrido en Postgres efimero en esta ronda).
import { describe, expect, it } from "vitest";
import { createAppointment, findAppointmentsForCustomerPhone } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { executeToolCall } from "../../src/whatsapp/llm-turn-handler.ts";
import { TEL_ESPERA, TEL_PACIENTE, ZONA, canalWhatsapp, clinicaDental, herramienta, proximoDia, texto } from "./support.ts";

describe("viaje doble reserva", () => {
  it("WhatsApp y voz piden el mismo horario a la vez: una sola cita; el que pierde recibe un error claro (no 'quedó agendada')", async () => {
    const mundo = clinicaDental();
    const inicio = zonedTimeToUtc(proximoDia(2, 2), "10:00", ZONA).toISOString();
    const pedir = (phone: string, canal: "whatsapp" | "voice") =>
      executeToolCall(mundo.repo, { organizationId: mundo.organizationId, phone, name: "crear_cita", canal, input: { provider_id: mundo.drPaola, service_id: mundo.limpieza, customer_name: phone === TEL_PACIENTE ? "Ana Pech" : "Mario Chan", starts_at: inicio } });
    const [a, b] = await Promise.all([pedir(TEL_PACIENTE, "whatsapp"), pedir(TEL_ESPERA, "voice")]);
    const ganadores = [a, b].filter((x) => x.appointmentId !== null);
    const perdedores = [a, b].filter((x) => x.appointmentId === null);
    expect(ganadores).toHaveLength(1);
    expect(perdedores).toHaveLength(1);
    expect(String((perdedores[0]!.result as { error?: string }).error)).toMatch(/ya no está disponible|alguien más/i);
  });

  it("el panel (alta manual) no puede encimar una cita del agente para el mismo profesional", async () => {
    const mundo = clinicaDental();
    const inicio = zonedTimeToUtc(proximoDia(2, 2), "11:00", ZONA).toISOString();
    await createAppointment(mundo.repo, { organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, customerName: "Ana Pech", customerPhone: TEL_PACIENTE, startsAt: inicio, source: "whatsapp" });
    const panel = await mundo.repo.createAppointmentFromPanel({ organizationId: mundo.organizationId, providerId: mundo.drPaola, serviceId: mundo.limpieza, propertyId: null, customerName: "Mario Chan", customerPhone: TEL_ESPERA, customerEmail: null, startsAt: new Date(Date.parse(inicio) + 15 * 60_000).toISOString(), endsAt: new Date(Date.parse(inicio) + 45 * 60_000).toISOString(), notes: null });
    expect(panel.outcome).toBe("conflict_slot_taken");
  });

  it("dos mensajes casi simultaneos del MISMO paciente: un solo turno a la vez y una sola cita", async () => {
    const mundo = clinicaDental();
    const wa = canalWhatsapp(mundo);
    const inicio = zonedTimeToUtc(proximoDia(2, 2), "12:00", ZONA).toISOString();
    const guion = (_req: unknown, paso: number) => (paso % 2 === 0 ? herramienta(`c${paso}`, "crear_cita", { provider_id: mundo.drPaola, service_id: mundo.limpieza, customer_name: "Ana Pech", starts_at: inicio }) : texto("Listo."));
    const [r1, r2] = await Promise.all([wa.escribe(TEL_PACIENTE, "agéndame a las 12", guion), wa.escribe(TEL_PACIENTE, "a las 12 porfa")]);
    expect([r1.ok || r1.retryable, r2.ok || r2.retryable]).toEqual([true, true]);
    expect((await findAppointmentsForCustomerPhone(mundo.repo, mundo.organizationId, TEL_PACIENTE)).appointments).toHaveLength(1);
  });
});
