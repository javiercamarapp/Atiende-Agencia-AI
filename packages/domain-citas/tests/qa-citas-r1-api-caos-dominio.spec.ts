// Regresiones QA R1 (citas): validacion temporal del ciclo de la cita y entrada de texto. Ids: QA-citas-R1-features-04/05/06/09/11.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { completeAppointmentFromPanel, createAppointment, createAppointmentFromPanel, markAppointmentNoShowFromPanel, rescheduleAppointment } from "../src/appointments.ts";
import { computeCitasResumen } from "../src/resumen.ts";
import { executeToolCall } from "../src/whatsapp/llm-turn-handler.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { AppointmentConflictError, AppointmentValidationError } from "../src/errors.ts";
import { buildCitasFixture } from "./fixtures.ts";

const TZ = "America/Merida"; // UTC-6 todo el anio
const LUNES = "2027-09-13";
const LUNES_10 = zonedTimeToUtc(LUNES, "10:00", TZ).toISOString();
const LUNES_1030 = zonedTimeToUtc(LUNES, "10:30", TZ).toISOString();
const PHONE = "9991234567";

describe("QA R1 citas -- validacion temporal (dominio)", () => {
  const PASADO_10 = zonedTimeToUtc("2025-09-15", "10:00", TZ).toISOString(); // lunes pasado, en horario

  it("QA-citas-R1-features-04: createAppointment rechaza un horario pasado (web, WhatsApp y voz comparten el chequeo)", async () => {
    const f = buildCitasFixture();
    await expect(createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: PASADO_10, source: "whatsapp" })).rejects.toBeInstanceOf(
      AppointmentConflictError,
    );
  });

  it("QA-citas-R1-features-05: rescheduleAppointment rechaza mover una cita a un horario pasado", async () => {
    const f = buildCitasFixture();
    const a = await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: LUNES_10, source: "web" });
    await expect(rescheduleAppointment(f.repo, { organizationId: f.organizationId, appointmentId: a.id, newStartsAt: PASADO_10, actorChannel: "whatsapp" })).rejects.toBeInstanceOf(AppointmentConflictError);
  });

  it("QA-citas-R1-features-06: no-show y completar exigen que la cita ya haya empezado", async () => {
    const f = buildCitasFixture();
    const a = await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: LUNES_10, source: "web" });
    const b = await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Beto", customerPhone: "9997654321", startsAt: LUNES_1030, source: "web" });
    await expect(markAppointmentNoShowFromPanel(f.repo, f.organizationId, a.id, randomUUID())).rejects.toBeInstanceOf(AppointmentConflictError);
    await expect(completeAppointmentFromPanel(f.repo, f.organizationId, b.id, randomUUID())).rejects.toBeInstanceOf(AppointmentConflictError);
    // Ya empezada (reloj adelantado), si se puede.
    const despues = new Date(Date.parse(LUNES_10) + 3_600_000);
    await expect(markAppointmentNoShowFromPanel(f.repo, f.organizationId, a.id, randomUUID(), despues)).resolves.toMatchObject({ status: "no_show" });
  });
});

describe("QA R1 citas -- texto de entrada (features-09, features-11)", () => {
  const base = (f: ReturnType<typeof buildCitasFixture>) => ({ organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, source: "web" as const });

  it("QA-citas-R1-features-09: starts_at de texto libre es validacion, no un instante inventado", async () => {
    const f = buildCitasFixture();
    for (const startsAt of ["manana a las 10", "10", "2027-09-13", "13/09/2027 10:00"]) {
      await expect(createAppointment(f.repo, { ...base(f), startsAt })).rejects.toBeInstanceOf(AppointmentValidationError);
    }
    await expect(createAppointment(f.repo, { ...base(f), startsAt: "2027-09-13T10:00:00-06:00" })).resolves.toMatchObject({ status: "pending" });
  });

  it("QA-citas-R1-features-11: un byte NUL en nombre, telefono, correo o notas es AppointmentValidationError (Postgres lo rechazaria con 22021)", async () => {
    const f = buildCitasFixture();
    for (const malo of [{ customerName: "Ana\u0000QA" }, { customerPhone: "99912\u000034567" }, { customerEmail: "a@b.mx\u0000" }, { notes: "nota\u0000" }]) {
      await expect(createAppointment(f.repo, { ...base(f), startsAt: LUNES_10, ...malo })).rejects.toBeInstanceOf(AppointmentValidationError);
    }
  });
});

describe("QA R1 citas -- una sucursal no ve las citas de otra (caos-01, caos-02, caos-03)", () => {
  const AHORA = new Date("2027-09-13T15:00:00.000Z"); // lunes 09:00 en Merida
  const cita = (f: ReturnType<typeof buildCitasFixture>, propertyId: string | null, startsAt: string) => ({
    id: randomUUID(),
    organizationId: f.organizationId,
    propertyId,
    providerId: f.providerId,
    serviceId: f.serviceId,
    customerId: randomUUID(),
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
    status: "confirmed" as const,
    source: "manual" as const,
    notes: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    reminder24hSentAt: null,
    createdAt: AHORA.toISOString(),
    googleEventId: null,
    googleSyncStatus: "skipped" as const,
    googleSyncAttempts: 0,
    googleSyncNextRetryAt: null,
    googleSyncError: null,
  });

  it("QA-citas-R1-caos-01: la lista y el Resumen de una sucursal solo cuentan las citas de esa sucursal (y las de proveedores sin sucursal)", async () => {
    const f = buildCitasFixture();
    const centro = randomUUID();
    const norte = randomUUID();
    f.repo.seedAppointment(cita(f, centro, LUNES_10));
    f.repo.seedAppointment(cita(f, centro, LUNES_1030));
    f.repo.seedAppointment(cita(f, norte, "2027-09-13T17:00:00.000Z"));
    f.repo.seedAppointment(cita(f, null, "2027-09-13T18:00:00.000Z"));
    const desde = "2027-09-13T00:00:00.000Z";
    const hasta = "2027-09-14T00:00:00.000Z";
    expect((await f.repo.listAppointmentsInRange(f.organizationId, desde, hasta, undefined, 50, norte)).map((a) => a.propertyId).sort()).toEqual([null, norte].sort());
    expect(await f.repo.listAppointmentsInRange(f.organizationId, desde, hasta, undefined, 50)).toHaveLength(4);
    const resumenNorte = await computeCitasResumen(f.repo, f.organizationId, TZ, AHORA, norte);
    const resumenCentro = await computeCitasResumen(f.repo, f.organizationId, TZ, AHORA, centro);
    expect(resumenNorte.today.total).toBe(2);
    expect(resumenCentro.today.total).toBe(3);
  });

  it("QA-citas-R1-caos-02: el alta del panel rechaza un proveedor de OTRA sucursal", async () => {
    const f = buildCitasFixture();
    const otraSucursal = randomUUID();
    f.repo.seedProvider({ id: f.providerId, organizationId: f.organizationId, propertyId: randomUUID(), displayName: "Dra. Centro", roleLabel: "Dentista", isActive: true });
    await expect(
      createAppointmentFromPanel(f.repo, { organizationId: f.organizationId, propertyId: otraSucursal, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: LUNES_10 }),
    ).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("QA-citas-R1-caos-03: reintentar el alta con la misma llave devuelve la misma cita; otro cliente en ese horario sigue siendo 409", async () => {
    const f = buildCitasFixture();
    const base = { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: LUNES_10 };
    const primera = await createAppointmentFromPanel(f.repo, { ...base, idempotencyKey: "k1" });
    const reintento = await createAppointmentFromPanel(f.repo, { ...base, idempotencyKey: "k1" });
    expect(reintento.id).toBe(primera.id);
    await expect(createAppointmentFromPanel(f.repo, base)).rejects.toBeInstanceOf(AppointmentConflictError); // sin llave: 409 honesto
    await expect(createAppointmentFromPanel(f.repo, { ...base, customerPhone: "9997654321", customerName: "Beto", idempotencyKey: "k2" })).rejects.toBeInstanceOf(AppointmentConflictError);
  });
});

describe("QA R1 citas -- reglas de horario traslapadas (features-13)", () => {
  it("QA-citas-R1-features-13: 09:00-17:00 mas 12:15-14:00 el mismo dia no producen horarios encimados ni repetidos", async () => {
    const f = buildCitasFixture();
    f.repo.seedAvailabilityRule({ id: randomUUID(), providerId: f.providerId, dayOfWeek: 1, startTime: "12:15", endTime: "14:00", isActive: true });
    f.repo.seedAvailabilityRule({ id: randomUUID(), providerId: f.providerId, dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isActive: true }); // duplicada exacta
    const out = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "consultar_disponibilidad", input: { provider_id: f.providerId, service_id: f.serviceId, date: LUNES } });
    const slots = (out.result as { slots: Array<{ starts_at: string; ends_at: string }> }).slots.map((x) => ({ a: Date.parse(x.starts_at), b: Date.parse(x.ends_at) }));
    expect(slots.some((x, i) => slots.some((y, j) => i !== j && x.a < y.b && y.a < x.b))).toBe(false);
    expect(slots).toHaveLength(16); // 09:00-17:00 en bloques de 30 min, una sola vez cada uno
  });
});
