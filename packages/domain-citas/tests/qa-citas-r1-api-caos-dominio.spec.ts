// Regresiones QA R1 (citas): validacion temporal del ciclo de la cita y entrada de texto. Ids: QA-citas-R1-features-04/05/06/09/11.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { completeAppointmentFromPanel, createAppointment, markAppointmentNoShowFromPanel, rescheduleAppointment } from "../src/appointments.ts";
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
