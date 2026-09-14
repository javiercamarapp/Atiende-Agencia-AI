// Tests reales (no mockeados) de las 3 guardias de negocio críticas de
// appointments.ts, ejercitando InMemoryCitasRepository — mismo criterio que
// domain-restaurantes/tests/orders.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointment, cancelAppointmentFromPanel, completeAppointmentFromPanel, confirmAppointmentFromPanel, createAppointment, markAppointmentNoShowFromPanel, reassignAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "../src/errors.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { buildCitasFixture } from "./fixtures.ts";
import type { CreateAppointmentPayload } from "../src/types.ts";

// Fecha fija a propósito un año hacia el futuro (mismo día de la semana, lunes)
// respecto a cuando se escribió este test: el motor de alternativas usa
// `now = new Date()` real por defecto y filtra slots ya pasados -- una fecha
// que "ya era futuro" cuando se escribió pero coincide con el reloj real deja
// de serlo apenas el calendario la alcanza (date-rot, ya visto varias veces en
// esta suite -- ver los commits "barrido completo de date-rot").
const MONDAY_10AM_MERIDA = zonedTimeToUtc("2027-09-13", "10:00", "America/Merida").toISOString();
const MONDAY_1030AM_MERIDA = zonedTimeToUtc("2027-09-13", "10:30", "America/Merida").toISOString();

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
    const madrugada = zonedTimeToUtc("2027-09-13", "03:00", "America/Merida").toISOString();
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

// Fase 7 — gap real: ninguna función de negocio escribía 'confirmed'/'completed'/
// 'no_show' aunque el esquema (001_citas_schema.sql) siempre los permitió — ver
// cabecera de appointments.ts.
describe("confirmAppointmentFromPanel / completeAppointmentFromPanel / markAppointmentNoShowFromPanel", () => {
  it("confirmar una cita pending real la marca confirmed", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const confirmed = await confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(confirmed.status).toBe("confirmed");
  });

  it("confirmar una cita ya confirmed es un no-op idempotente (nunca error)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    const second = await confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(second.status).toBe("confirmed");
  });

  it("confirmar una cita ya cancelada es un conflicto real, nunca la revive en silencio", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    await expect(confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID())).rejects.toThrow(AppointmentConflictError);
  });

  it("confirmar una cita de OTRA organización nunca se encuentra (scope real, nunca solo por id)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await expect(confirmAppointmentFromPanel(fixture.repo, randomUUID(), appointment.id, randomUUID())).rejects.toThrow(AppointmentNotFoundError);
  });

  it("completar una cita pending (sin pasar por confirmed) la marca completed", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const completed = await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(completed.status).toBe("completed");
  });

  it("completar una cita confirmed la marca completed", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await confirmAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    const completed = await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(completed.status).toBe("completed");
  });

  it("completar una cita ya completed es un no-op idempotente", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    const second = await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(second.status).toBe("completed");
  });

  it("completar una cita ya cancelada es un conflicto real", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    await expect(completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID())).rejects.toThrow(AppointmentConflictError);
  });

  it("marcar no-show una cita pending la marca no_show", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const noShow = await markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(noShow.status).toBe("no_show");
  });

  it("marcar no-show una cita ya no_show es un no-op idempotente", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    const second = await markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    expect(second.status).toBe("no_show");
  });

  it("marcar no-show una cita ya completed es un conflicto real", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await completeAppointmentFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    await expect(markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID())).rejects.toThrow(AppointmentConflictError);
  });

  it("no-show libera el horario del proveedor: otra cita puede reservarse en el mismo slot (fuera del EXCLUDE using gist)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await markAppointmentNoShowFromPanel(fixture.repo, fixture.organizationId, appointment.id, randomUUID());
    const rebooked = await createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9998887777" }));
    expect(rebooked.startsAt).toBe(MONDAY_10AM_MERIDA);
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
    const madrugada = zonedTimeToUtc("2027-09-13", "03:00", "America/Merida").toISOString();
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

describe("reassignAppointment -- Fase 4, cambio de proveedor/servicio sin tocar horario", () => {
  function seedSecondProvider(fixture: ReturnType<typeof buildCitasFixture>, opts: { readonly offersOriginalService?: boolean } = {}) {
    const providerId = randomUUID();
    fixture.repo.seedProvider({ id: providerId, organizationId: fixture.organizationId, propertyId: null, displayName: "Dr. Roberto Cen", roleLabel: "Dentista", isActive: true });
    if (opts.offersOriginalService !== false) fixture.repo.seedProviderService(providerId, fixture.serviceId);
    for (const dayOfWeek of [1, 2, 3, 4, 5]) {
      fixture.repo.seedAvailabilityRule({ id: randomUUID(), providerId, dayOfWeek, startTime: "09:00", endTime: "17:00", isActive: true });
    }
    return providerId;
  }

  it("cambia SOLO el proveedor, preservando el MISMO id y el MISMO horario de inicio", async () => {
    const fixture = buildCitasFixture();
    const otroProviderId = seedSecondProvider(fixture);
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));

    const { appointment: reasignada, previousProviderId, previousServiceId } = await reassignAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      appointmentId: appointment.id,
      newProviderId: otroProviderId,
    });

    expect(reasignada.id).toBe(appointment.id);
    expect(reasignada.providerId).toBe(otroProviderId);
    expect(reasignada.serviceId).toBe(fixture.serviceId); // no se tocó -- no vino newServiceId.
    expect(reasignada.startsAt).toBe(MONDAY_10AM_MERIDA); // el horario de inicio NUNCA se toca.
    expect(previousProviderId).toBe(fixture.providerId);
    expect(previousServiceId).toBe(fixture.serviceId);
  });

  it("cambia SOLO el servicio (mismo proveedor) y recalcula ends_at desde la duración del servicio nuevo", async () => {
    const fixture = buildCitasFixture();
    const servicioLargoId = randomUUID();
    fixture.repo.seedService({ id: servicioLargoId, organizationId: fixture.organizationId, name: "Limpieza profunda", durationMinutes: 60, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 90000, isActive: true });
    fixture.repo.seedProviderService(fixture.providerId, servicioLargoId);
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    const horaFinOriginal = appointment.endsAt;

    const { appointment: reasignada } = await reassignAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      appointmentId: appointment.id,
      newServiceId: servicioLargoId,
    });

    expect(reasignada.providerId).toBe(fixture.providerId); // no se tocó -- no vino newProviderId.
    expect(reasignada.serviceId).toBe(servicioLargoId);
    expect(reasignada.startsAt).toBe(MONDAY_10AM_MERIDA);
    expect(reasignada.endsAt).not.toBe(horaFinOriginal); // 60 min en vez de 30 -- ends_at real distinto.
    expect(new Date(reasignada.endsAt).getTime() - new Date(reasignada.startsAt).getTime()).toBe(60 * 60_000);
  });

  it("rechaza reasignar a un proveedor que no ofrece el servicio solicitado", async () => {
    const fixture = buildCitasFixture();
    const otroProviderId = seedSecondProvider(fixture, { offersOriginalService: false });
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));

    await expect(
      reassignAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newProviderId: otroProviderId }),
    ).rejects.toThrow(AppointmentValidationError);
  });

  it("rechaza reasignar al proveedor NUEVO si ya tiene otra cita real en ese mismo horario, con alternativas reales", async () => {
    const fixture = buildCitasFixture();
    const otroProviderId = seedSecondProvider(fixture);
    // El proveedor nuevo YA tiene una cita a las 10:00 -- el horario que la cita
    // original conserva al reasignarse (nunca se toca startsAt).
    await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: otroProviderId, serviceId: fixture.serviceId, customerName: "Otro cliente", customerPhone: "9993333333", startsAt: MONDAY_10AM_MERIDA, source: "web" });
    const appointment = await createAppointment(fixture.repo, basePayload(fixture, { customerPhone: "9991111111" }));

    let caught: unknown;
    try {
      await reassignAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newProviderId: otroProviderId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppointmentAlternativesError);
    expect((caught as AppointmentAlternativesError).alternativeSlots.length).toBeGreaterThan(0);
  });

  it("exige al menos un cambio real (newProviderId/newServiceId ausentes, o iguales a lo que la cita ya tiene, es error de validación)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));

    await expect(reassignAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id })).rejects.toThrow(AppointmentValidationError);
    await expect(
      reassignAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newProviderId: fixture.providerId, newServiceId: fixture.serviceId }),
    ).rejects.toThrow(AppointmentValidationError);
  });

  it("no se puede modificar una cita cancelada", async () => {
    const fixture = buildCitasFixture();
    const otroProviderId = seedSecondProvider(fixture);
    const appointment = await createAppointment(fixture.repo, basePayload(fixture));
    await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });

    await expect(
      reassignAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newProviderId: otroProviderId }),
    ).rejects.toThrow(AppointmentConflictError);
  });
});
