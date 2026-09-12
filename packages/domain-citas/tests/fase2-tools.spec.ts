// Fase 2 §1/§5 — tests unitarios reales (contra InMemoryCitasRepository, no
// mockeados) de las funciones de dominio nuevas que respaldan los 4 Server Tools
// de voz Y las tools equivalentes del agente de WhatsApp (§2.4 "un solo núcleo,
// dos canales"): queryAvailability, findAppointmentsForCustomerPhone,
// listActiveServices/listActiveProviders.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAppointment, findAppointmentsForCustomerPhone, queryAvailability } from "../src/appointments.ts";
import { AppointmentValidationError } from "../src/errors.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { buildCitasFixture, nextWeekdayDateStr } from "./fixtures.ts";

const NEXT_MONDAY = nextWeekdayDateStr(new Date(), 1);

describe("queryAvailability — Fase 2 §1.1 (consultar_disponibilidad)", () => {
  it("devuelve slots reales calculados con el mismo motor que availability.ts", async () => {
    const fixture = buildCitasFixture();
    const { slots } = await queryAvailability(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      dateStr: NEXT_MONDAY,
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]!.startsAt).toBe(zonedTimeToUtc(NEXT_MONDAY, "09:00", "America/Merida").toISOString());
  });

  it("un slot ya ocupado por otra cita real desaparece de la lista", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc(NEXT_MONDAY, "09:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Existente",
      customerPhone: "9990000000",
      startsAt,
      source: "web",
    });
    const { slots } = await queryAvailability(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      dateStr: NEXT_MONDAY,
    });
    expect(slots.some((s) => s.startsAt === startsAt)).toBe(false);
  });

  it("un día sin ninguna regla de disponibilidad (domingo) devuelve lista vacía, nunca un error", async () => {
    const fixture = buildCitasFixture();
    const sunday = nextWeekdayDateStr(new Date(), 0);
    const { slots } = await queryAvailability(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, dateStr: sunday });
    expect(slots).toEqual([]);
  });

  it("GUARDIA: rechaza un `date` con formato inválido antes de tocar zonedTimeToUtc — nunca deja pasar un string arbitrario", async () => {
    const fixture = buildCitasFixture();
    for (const invalid of ["mañana", "2026/09/14", "2026-13-01", "2026-02-30", "", "2026-09-14T10:00:00Z"]) {
      await expect(
        queryAvailability(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, dateStr: invalid }),
      ).rejects.toThrow(AppointmentValidationError);
    }
  });

  it("propaga AppointmentValidationError si el proveedor no ofrece el servicio (reutiliza resolveProviderAndService sin tocarlo)", async () => {
    const fixture = buildCitasFixture();
    const otroServicio = randomUUID();
    fixture.repo.seedService({ id: otroServicio, organizationId: fixture.organizationId, name: "Otro servicio", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: true });
    await expect(
      queryAvailability(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: otroServicio, dateStr: NEXT_MONDAY }),
    ).rejects.toThrow(AppointmentValidationError);
  });
});

describe("findAppointmentsForCustomerPhone — Fase 2 §1.4 (buscar_citas_cliente / buscar_mis_citas)", () => {
  it("CONTRATO DE SILENCIO: un teléfono nunca visto devuelve lista vacía, nunca un error — mismo criterio que restaurantes ante cero-match", async () => {
    const fixture = buildCitasFixture();
    const result = await findAppointmentsForCustomerPhone(fixture.repo, fixture.organizationId, "9998887777");
    expect(result).toEqual({ appointments: [] });
  });

  it("devuelve solo citas activas/próximas reales (pending|confirmed, startsAt >= now) — nunca canceladas ni pasadas", async () => {
    const fixture = buildCitasFixture();
    const phone = "9991112222";
    const futuraStartsAt = zonedTimeToUtc(NEXT_MONDAY, "10:00", "America/Merida").toISOString();
    const created = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Fase 2",
      customerPhone: phone,
      startsAt: futuraStartsAt,
      source: "whatsapp",
    });

    // Una cita YA CANCELADA del mismo cliente nunca debe aparecer en el resultado.
    const canceladaStartsAt = zonedTimeToUtc(NEXT_MONDAY, "11:00", "America/Merida").toISOString();
    const cancelada = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Fase 2",
      customerPhone: phone,
      startsAt: canceladaStartsAt,
      source: "whatsapp",
    });
    fixture.repo.seedAppointment({ ...(await fixture.repo.findAppointmentForOrganization(fixture.organizationId, cancelada.id))!, status: "cancelled" });

    const result = await findAppointmentsForCustomerPhone(fixture.repo, fixture.organizationId, phone);
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0]!.appointmentId).toBe(created.id);
  });

  it("normaliza el teléfono antes de buscar (mismos últimos 10 dígitos, distinto formato) — mismo criterio que crear_cita", async () => {
    const fixture = buildCitasFixture();
    const startsAt = zonedTimeToUtc(NEXT_MONDAY, "09:00", "America/Merida").toISOString();
    await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Normalizado",
      customerPhone: "+52 999 123 4567",
      startsAt,
      source: "voice",
    });
    const result = await findAppointmentsForCustomerPhone(fixture.repo, fixture.organizationId, "9991234567");
    expect(result.appointments).toHaveLength(1);
  });

  it("nunca filtra citas de OTRA organización aunque el teléfono normalizado coincida", async () => {
    const fixture = buildCitasFixture();
    const otraOrgId = randomUUID();
    fixture.repo.seedOrganization({ id: otraOrgId, slug: "otro-negocio", name: "Otro negocio", defaultTimezone: "America/Merida" });
    const result = await findAppointmentsForCustomerPhone(fixture.repo, otraOrgId, "9991234567");
    expect(result).toEqual({ appointments: [] });
  });
});

describe("listActiveServices/listActiveProviders — Fase 2 §1.2/§1.3 (listar_servicios/listar_proveedores)", () => {
  it("listActiveServices nunca devuelve un servicio inactivo", async () => {
    const fixture = buildCitasFixture();
    const inactivo = randomUUID();
    fixture.repo.seedService({ id: inactivo, organizationId: fixture.organizationId, name: "Servicio descontinuado", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: false });
    const services = await fixture.repo.listActiveServices(fixture.organizationId);
    expect(services.map((s) => s.id)).toContain(fixture.serviceId);
    expect(services.map((s) => s.id)).not.toContain(inactivo);
  });

  it("listActiveProviders con service_id filtra solo a quienes ofrecen ese servicio real", async () => {
    const fixture = buildCitasFixture();
    const otroProveedor = randomUUID();
    fixture.repo.seedProvider({ id: otroProveedor, organizationId: fixture.organizationId, propertyId: null, displayName: "Dr. Otro", roleLabel: "Dentista", isActive: true });
    const otroServicio = randomUUID();
    fixture.repo.seedService({ id: otroServicio, organizationId: fixture.organizationId, name: "Limpieza", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: null, isActive: true });
    fixture.repo.seedProviderService(otroProveedor, otroServicio);

    const providersDelServicioOriginal = await fixture.repo.listActiveProviders(fixture.organizationId, fixture.serviceId);
    expect(providersDelServicioOriginal.map((p) => p.id)).toEqual([fixture.providerId]);

    const providersDeLimpieza = await fixture.repo.listActiveProviders(fixture.organizationId, otroServicio);
    expect(providersDeLimpieza.map((p) => p.id)).toEqual([otroProveedor]);
  });

  it("sin service_id devuelve todos los proveedores activos de la organización", async () => {
    const fixture = buildCitasFixture();
    const inactivo = randomUUID();
    fixture.repo.seedProvider({ id: inactivo, organizationId: fixture.organizationId, propertyId: null, displayName: "Inactivo", roleLabel: "x", isActive: false });
    const providers = await fixture.repo.listActiveProviders(fixture.organizationId);
    expect(providers.map((p) => p.id)).toContain(fixture.providerId);
    expect(providers.map((p) => p.id)).not.toContain(inactivo);
  });
});
