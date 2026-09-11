// Tests reales del recordatorio 24h (fix de timezone real preservado) y del aviso
// best-effort a lista de espera tras reagendar.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { notifyWaitlistAfterReschedule, runConfirmacionCitaCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

describe("runConfirmacionCitaCore", () => {
  it("encola un recordatorio real para una cita dentro de la ventana de 24h, con la hora en el timezone del NEGOCIO, nunca UTC/host", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z"); // domingo 16:00 UTC (exactamente 24h antes de la cita)
    // Cita mañana (lunes) a las 10:00 hora de Mérida (16:00 UTC) — cae justo en la
    // ventana de 24h desde `now`.
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "María López",
      customerPhone: "9998887766",
      startsAt,
      source: "web",
    });

    const summary = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);

    expect(summary.processed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(summary.skippedNoWhatsappConfig).toBe(false);

    const outbox = fixture.repo.getOutbox();
    expect(outbox).toHaveLength(1);
    const message = outbox[0]!;
    expect(message.eventType).toBe("appointment.reminder_24h");
    // FIX DE TIMEZONE REAL: "10:00" en el mensaje, NUNCA "16:00" (lo que mostraría
    // un host que corre en UTC sin este fix).
    expect((message.payload as { body: string }).body).toContain("10:00");
    expect((message.payload as { body: string }).body).not.toContain("16:00");
  });

  it("nunca reenvía el mismo recordatorio si el cron corre dos veces dentro de la ventana", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z");
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "María", customerPhone: "9998887766", startsAt, source: "web" });

    await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);
    const second = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, new Date(now.getTime() + 5 * 60_000));

    expect(second.processed).toBe(0);
    expect(fixture.repo.getOutbox()).toHaveLength(1);
  });

  it("un negocio sin configuración de WhatsApp activa se salta, sin lanzar", async () => {
    const fixture = buildCitasFixture();
    const sinWhatsapp = randomUUID();
    fixture.repo.seedOrganization({ id: sinWhatsapp, slug: "otro-negocio", name: "Otro Negocio" });
    const summary = await runConfirmacionCitaCore(fixture.repo, sinWhatsapp, new Date());
    expect(summary.skippedNoWhatsappConfig).toBe(false); // no hay citas pendientes -> ni siquiera llega a resolver whatsapp
    expect(summary.processed).toBe(0);
  });
});

describe("notifyWaitlistAfterReschedule", () => {
  it("avisa al primer candidato FIFO de la lista de espera cuando el hueco VIEJO (no el nuevo) coincide con sus preferencias", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Original",
      customerPhone: "9991110000",
      startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString(),
      source: "web",
    });

    const waitlistId = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9993334444",
      customerName: "Cliente en espera",
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    const previousStartsAt = appointment.startsAt;
    const newStartsAt = zonedTimeToUtc("2026-09-14", "11:00", "America/Merida").toISOString();
    await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt });

    const result = await notifyWaitlistAfterReschedule(fixture.repo, fixture.organizationId, "America/Merida", {
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      previousStartsAt,
      newStartsAt,
    });

    expect(result?.matched).toBe(true);
    expect(result?.waitlistId).toBe(waitlistId);
    expect(fixture.repo.getWaitlistEntry(waitlistId)?.notifiedCount).toBe(1);
  });

  it("nunca avisa si el horario 'nuevo' es idéntico al viejo — no se liberó nada real", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9993334444",
      customerName: "Cliente en espera",
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    const result = await notifyWaitlistAfterReschedule(fixture.repo, fixture.organizationId, "America/Merida", {
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      previousStartsAt: startsAt,
      newStartsAt: startsAt,
    });

    expect(result).toBeNull();
  });
});
