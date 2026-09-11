// Test de integración end-to-end del flujo real más crítico del vertical (ver
// diseño Fase 1 citas, tarea 5): "cliente reserva -> reagenda -> se libera su hueco
// viejo -> alguien en lista de espera es notificado -> el negocio cancela desde el
// panel". Ejercita createAppointment + rescheduleAppointment +
// notifyWaitlistAfterReschedule + cancelAppointmentFromPanel juntos, sobre el MISMO
// repositorio — sin mocks de la lógica de negocio, solo el adaptador en memoria en
// vez de Postgres real (mismo criterio que
// domain-restaurantes/tests/integration/pedido-cliente-flow.spec.ts).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointmentFromPanel, createAppointment, rescheduleAppointment } from "../../src/appointments.ts";
import { zonedTimeToUtc } from "../../src/availability.ts";
import { AppointmentConflictError, AppointmentNotFoundError } from "../../src/errors.ts";
import { notifyWaitlistAfterReschedule, runConfirmacionCitaCore } from "../../src/reminders.ts";
import { buildCitasFixture } from "../fixtures.ts";

describe("Flujo real: reservar -> reagendar (libera el hueco viejo) -> lista de espera avisada -> cancelar desde panel", () => {
  it("ejercita las 3 capas de anti-doble-reserva + el aviso best-effort de lista de espera + el cierre del ciclo de vida, todo con el mismo repositorio", async () => {
    const fixture = buildCitasFixture();
    const lunes10am = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const lunes1030am = zonedTimeToUtc("2026-09-14", "10:30", "America/Merida").toISOString();

    // 1) RESERVAR — flujo real de POST /v1/citas/:orgSlug/appointments: valida,
    // revalida el slot contra disponibilidad real, crea al cliente (memoria por
    // teléfono) e inserta la cita de forma idempotente.
    const appointment = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Ana Torres",
      customerPhone: "999 111 22 33",
      customerEmail: "ana@example.com",
      startsAt: lunes10am,
      source: "web",
    });
    expect(appointment.status).toBe("pending");

    // 2) Alguien más intenta agendar EXACTAMENTE ese mismo slot con el mismo
    // proveedor — rechazado por la capa 1 de anti-doble-reserva (EXCLUDE real).
    await expect(
      createAppointment(fixture.repo, {
        organizationId: fixture.organizationId,
        providerId: fixture.providerId,
        serviceId: fixture.serviceId,
        customerName: "Otro Cliente",
        customerPhone: "9998887777",
        startsAt: lunes10am,
        source: "web",
      }),
    ).rejects.toThrow(AppointmentConflictError);

    // 3) Un cliente distinto se anota en la lista de espera para ESE proveedor/
    // servicio, sin preferencia de fecha/franja.
    const waitlistId = fixture.repo.seedWaitlistEntry({
      organizationId: fixture.organizationId,
      customerPhone: "9995556666",
      customerName: "Cliente en espera",
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredTimeWindow: "any",
    });

    // 4) REAGENDAR — Ana mueve su cita a las 10:30am. Conserva el MISMO id (nunca
    // cancela+recrea), y el hueco que se libera es el horario VIEJO (10am), nunca
    // el nuevo.
    const previousStartsAt = appointment.startsAt;
    const { appointment: rescheduled } = await rescheduleAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      appointmentId: appointment.id,
      newStartsAt: lunes1030am,
      actorChannel: "web",
    });
    expect(rescheduled.id).toBe(appointment.id);
    expect(rescheduled.startsAt).toBe(lunes1030am);

    // 5) Aviso best-effort a la lista de espera: el cliente en espera matchea (sin
    // preferencia) y es notificado del hueco de las 10am que se acaba de liberar.
    const optimizador = await notifyWaitlistAfterReschedule(fixture.repo, fixture.organizationId, "America/Merida", {
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      previousStartsAt,
      newStartsAt: lunes1030am,
    });
    expect(optimizador?.matched).toBe(true);
    expect(optimizador?.waitlistId).toBe(waitlistId);

    // 6) Ahora SÍ es posible agendar el hueco viejo (10am) — de verdad quedó libre.
    const nuevaCitaEnHuecoLiberado = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente en espera",
      customerPhone: "9995556666",
      startsAt: previousStartsAt,
      source: "web",
    });
    expect(nuevaCitaEnHuecoLiberado.startsAt).toBe(previousStartsAt);

    // 7) El recordatorio 24h para la cita reagendada de Ana debe calcularse sobre
    // el horario NUEVO (10:30am), nunca el viejo — reminder_24h_sent_at se limpió
    // al reagendar (ver migración 002).
    const summary = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, new Date("2026-09-13T16:15:00.000Z"));
    expect(summary.sent).toBe(2); // la cita de Ana (reagendada) + la del hueco liberado
    const anaReminder = fixture.repo.getOutbox().find((m) => m.dedupeKey === `reminder-24h:${appointment.id}`);
    expect((anaReminder?.payload as { body: string }).body).toContain("10:30");

    // 8) CANCELAR DESDE EL PANEL — el negocio cancela la cita de Ana. Sin
    // distinción de rol (ver roles.ts: el origen no restringe por rol quién
    // cancela desde el panel).
    const cancelled = await cancelAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(cancelled.status).toBe("cancelled");

    // 9) Cancelar de nuevo es un no-op idempotente (nunca error), y cancelar una
    // cita de otra organización nunca se encuentra (scope real).
    const cancelledAgain = await cancelAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(cancelledAgain.status).toBe("cancelled");
    await expect(cancelAppointmentFromPanel(fixture.repo, randomUUID(), appointment.id, randomUUID())).rejects.toThrow(AppointmentNotFoundError);
  });
});
