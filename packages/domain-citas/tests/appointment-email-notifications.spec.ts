// Pruebas de enqueueAppointmentEmailCore/tryEnqueueAppointmentEmail — port de
// citas-reservaciones/supabase/functions/_shared/appointment-email-notifications.test.ts
// sobre InMemoryCitasRepository. Verifica: (1) arma el correo real (to/subject/
// html) a partir de solo el appointmentId, (2) sin correo del cliente no encola
// nada (no es un error), (3) cada evento tiene su dedupe_key real, (4) es
// best-effort de verdad (tryEnqueueAppointmentEmail nunca lanza).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointment, completeAppointmentFromPanel, confirmAppointmentFromPanel, createAppointment, markAppointmentNoShowFromPanel, rescheduleAppointment } from "../src/appointments.ts";
import { enqueueAppointmentEmailCore, tryEnqueueAppointmentEmail } from "../src/appointment-email-notifications.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { buildCitasFixture } from "./fixtures.ts";

describe("enqueueAppointmentEmailCore", () => {
  it("appointment.created: arma el correo real con to/subject/html a partir de solo el appointmentId", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María López", customerPhone: "9998887766", customerEmail: "maria@example.com", startsAt, source: "web" });

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.created", appointment.id);
    expect(result.enqueued).toBe(true);

    const job = fixture.repo.getOutbox().find((o) => o.channel === "email" && o.eventType === "appointment.created");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`created:${appointment.id}`);
    const payload = job!.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("maria@example.com");
    expect(payload.subject).toContain("Cita agendada");
    expect(payload.subject).toContain("Clínica Dental Sonrisas");
    expect(payload.html).toContain("María López");
    expect(payload.html).toContain("Consulta general");
    expect(payload.html).toContain("Dra. Fernanda López");
    expect(payload.text).toContain("María López");
  });

  it("sin correo del cliente en archivo: no encola nada, y NO es un error", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Sin Correo", customerPhone: "9998887777", startsAt, source: "web" });

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.created", appointment.id);
    expect(result).toEqual({ enqueued: false, reason: "no_email" });
    expect(fixture.repo.getOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });

  it("appointmentId inexistente: no encola nada", async () => {
    const fixture = buildCitasFixture();
    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.created", "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ enqueued: false, reason: "appointment_not_found" });
  });

  it("appointment.cancelled: dedupe_key propio, distinto del de creación", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.cancelled", appointment.id);
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.cancelled");
    expect(job!.dedupeKey).toBe(`cancelled:${appointment.id}`);
    const payload = job!.payload as { subject: string };
    expect(payload.subject).toContain("Cita cancelada");
  });

  it("appointment.rescheduled: incluye la fecha ANTERIOR real en el correo, nunca la nueva dos veces", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    const newStartsAt = zonedTimeToUtc("2026-09-14", "11:00", "America/Merida").toISOString();
    const { previousStartsAt } = await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt });

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.rescheduled", appointment.id, { previousStartsAt });
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.rescheduled");
    const payload = job!.payload as { html: string; text: string };
    expect(payload.text).toContain("10:00"); // fecha anterior real, en el timezone del negocio.
    expect(payload.html).toContain("Reagendada");
  });

  it("appointment.confirmed: arma correo real con su propio dedupe_key, tras confirmAppointmentFromPanel", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    await confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.confirmed", appointment.id);
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.confirmed");
    expect(job!.dedupeKey).toBe(`confirmed:${appointment.id}`);
    const payload = job!.payload as { subject: string; html: string };
    expect(payload.subject).toContain("Cita confirmada");
    expect(payload.html).toContain("Confirmada");
  });

  it("appointment.completed: arma correo real con su propio dedupe_key, tras completeAppointmentFromPanel", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.completed", appointment.id);
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.completed");
    expect(job!.dedupeKey).toBe(`completed:${appointment.id}`);
    const payload = job!.payload as { subject: string; html: string };
    expect(payload.subject).toContain("Gracias por tu visita");
    expect(payload.html).toContain("Completada");
  });

  it("appointment.no_show: arma correo real con su propio dedupe_key, tras markAppointmentNoShowFromPanel", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    await markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());

    const result = await enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.no_show", appointment.id);
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.no_show");
    expect(job!.dedupeKey).toBe(`no-show:${appointment.id}`);
    const payload = job!.payload as { subject: string; html: string };
    expect(payload.subject).toContain("No asististe");
    expect(payload.html).toContain("No asistió");
  });

  it("evento desconocido lanza (nunca envía un correo sin plantilla real)", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente", customerPhone: "9998887766", customerEmail: "cliente@example.com", startsAt, source: "web" });
    // @ts-expect-error -- evento inválido a propósito, para probar el default del switch.
    await expect(enqueueAppointmentEmailCore(fixture.repo, fixture.organizationId, "appointment.unknown", appointment.id)).rejects.toThrow(/desconocido/);
  });
});

describe("tryEnqueueAppointmentEmail", () => {
  it("es best-effort real: nunca lanza, aunque el appointmentId no exista", async () => {
    const fixture = buildCitasFixture();
    const result = await tryEnqueueAppointmentEmail(fixture.repo, fixture.organizationId, "appointment.created", "no-existe");
    expect(result).toEqual({ enqueued: false, reason: "appointment_not_found" });
  });
});
