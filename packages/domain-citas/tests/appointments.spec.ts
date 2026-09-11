// Tests reales (no mockeados) de las 3 guardias de negocio críticas de
// appointments.ts, ejercitando InMemoryCitasRepository — mismo criterio que
// domain-restaurantes/tests/orders.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointment, cancelAppointmentFromPanel, createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "../src/errors.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { buildCitasFixture } from "./fixtures.ts";
import type { CreateAppointmentPayload } from "../src/types.ts";

const MONDAY_10AM_MERIDA = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
const MONDAY_1030AM_MERIDA = zonedTimeToUtc("2026-09-14", "10:30", "America/Merida").toISOString();

function basePayload(fixture: ReturnType<typeof buildCitasFixture>, overrides: Partial<CreateAppointmentPayload> = {}): CreateAppointmentPayload {
  return {
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerName: "Juan Pérez",
    customerPhone: "9991234567",
    startsAt: MONDAY_10AM_MERIDA,
    source: "web",
    ...overrides,
  };
}

describe("createAppointment", () => {
  it("crea una cita real en un slot válido y registra al cliente", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));

    expect(appointment.status).toBe("pending");
    expect(appointment.providerId).toBe(fixture.providerId);
    expect(appointment.startsAt).toBe(MONDAY_10AM_MERIDA);

    const customer = await fixture.repo.upsertCustomer(fixture.organizationId, "9991234567", "otro nombre");
    expect(customer.fullName).toBe("Juan Pérez"); // nunca sobreescribe un nombre ya conocido
  });

  it("rechaza un horario fuera de la disponibilidad real (3am, aunque nadie más lo tenga ocupado)", async () => {
    const fixture = buildCitasFixture();
    const madrugada = zonedTimeToUtc("2026-09-14", "03:00", "America/Merida").toISOString();
    await expect(createAppointment(fixture.repo, basePayload(fixture, { startsAt: madrugada }))).rejects.toThrow(AppointmentConflictError);
  });

  it("anti-doble-reserva: dos citas para el MISMO slot del MISMO proveedor — la segunda es rechazada", async () => {
    const fixture = buildCitasFixture();
    await createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9991111111" }));
    await expect(createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9992222222" }))).rejects.toThrow(AppointmentConflictError);
  });

  it("idempotencia: un reintento con el MISMO idempotencyKey y los MISMOS datos devuelve la cita existente, sin duplicar", async () => {
    const fixture = buildCitasFixture();
    const payload = basePayload(fixture, { idempotencyKey: "agent:conv_abc123" });
    const first = await createAppointment(fixture.repo, payload);
    const second = await createAppointment(fixture.repo, payload);
    expect(second.id).toBe(first.id);
  });

  it("idempotencia: la MISMA idempotencyKey con datos DISTINTOS es un conflicto real, nunca se devuelve la cita vieja en silencio", async () => {
    const fixture = buildCitasFixture();
    const key = "agent:conv_abc123";
    await createAppointment(fixture.repo, basePayload(fixture, { idempotencyKey: key }));
    await expect(createAppointment(fixture.repo, basePayload(fixture, { idempotencyKey: key, startsAt: MONDAY_1030AM_MERIDA }))).rejects.toThrow(AppointmentConflictError);
  });

  it("rechaza un proveedor que no ofrece el servicio solicitado", async () => {
    const fixture = buildCitasFixture();
    const otroServicio = randomUUID();
    fixture.repo.seedService({ id: otroServicio, organizationId: fixture.organizationId, name: "Blanqueamiento", durationMinutes: 60, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: true });
    await expect(createAppointment(fixture.repo, basePayload(fixture, { serviceId: otroServicio }))).rejects.toThrow(AppointmentValidationError);
  });
});

describe("cancelAppointment / cancelAppointmentFromPanel", () => {
  it("cancelar una cita pending real la marca cancelled", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const cancelled = await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancelar una cita ya cancelada es un no-op idempotente (nunca error)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    const secondCancel = await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    expect(secondCancel.status).toBe("cancelled");
  });

  it("cancelar una cita de OTRA organización nunca se encuentra (scope real, nunca solo por id)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await expect(cancelAppointment(fixture.repo, { organizationId: randomUUID(), appointmentId: appointment.id })).rejects.toThrow(AppointmentNotFoundError);
  });

  it("cancelar desde el panel de staff funciona igual (sin distinción de rol, ver roles.ts)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const cancelled = await cancelAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("rescheduleAppointment", () => {
  it("reagenda preservando el MISMO id (nunca cancela+recrea)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const { appointment: rescheduled, previousStartsAt } = await rescheduleAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      appointmentId: appointment.id,
      newStartsAt: MONDAY_1030AM_MERIDA,
    });
    expect(rescheduled.id).toBe(appointment.id);
    expect(rescheduled.startsAt).toBe(MONDAY_1030AM_MERIDA);
    expect(previousStartsAt).toBe(MONDAY_10AM_MERIDA);
  });

  it("reagendar a un horario fuera de disponibilidad real trae alternativas REALES calculadas con el mismo motor", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const madrugada = zonedTimeToUtc("2026-09-14", "03:00", "America/Merida").toISOString();
    let caught: unknown;
    try {
      await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt: madrugada });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppointmentAlternativesError);
    const alternatives = (caught as AppointmentAlternativesError).alternativeSlots;
    expect(alternatives.length).toBeGreaterThan(0);
    // Ninguna alternativa se ve bloqueada por la propia cita reagendándose "sobre sí
    // misma" — se excluyó del cálculo de busy (ver loadBusyForDay).
    expect(alternatives.some((s) => s.startsAt === MONDAY_10AM_MERIDA)).toBe(true);
  });

  it("reagendar a un horario ya tomado por OTRA cita real del mismo proveedor es rechazado con alternativas", async () => {
    const fixture = buildCitasFixture();
    const primera = await createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9991111111" }));
    await createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9992222222", startsAt: MONDAY_1030AM_MERIDA }));

    await expect(
      rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: primera.id, newStartsAt: MONDAY_1030AM_MERIDA }),
    ).rejects.toThrow(AppointmentAlternativesError);
  });

  it("reagendar EXCLUYE la propia cita de su cálculo de disponibilidad (puede reagendarse cerca de su propio horario)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    // Reagendar al mismo slot que ya tiene (no-op real) nunca debe fallar por verse
    // a sí misma como "ocupada".
    const { appointment: rescheduled } = await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt: MONDAY_10AM_MERIDA });
    expect(rescheduled.startsAt).toBe(MONDAY_10AM_MERIDA);
  });

  it("no se puede reagendar una cita cancelada", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    await expect(rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt: MONDAY_1030AM_MERIDA })).rejects.toThrow(AppointmentConflictError);
  });
});
