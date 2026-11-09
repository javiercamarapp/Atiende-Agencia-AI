// Regresion QA R1 (citas): lo que ve el agente de WhatsApp y de voz lleva la hora LOCAL del negocio, y un starts_at sin zona ya no se lee en la zona del servidor.
// Ids: QA-citas-R1-seguridad-08, agentes-01, features-01/02/03, viaje-01/02/09, automatizacion-04.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppointment, createAppointmentFromPanel, rescheduleAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { lookupCitasCustomer } from "../src/customers.ts";
import { AppointmentValidationError } from "../src/errors.ts";
import { isIsoInstantWithZone, localDateTimeLabel, localTimeFields } from "../src/local-time.ts";
import { runOptimizadorCore } from "../src/reminders.ts";
import { ejecutarToolVozCitas } from "../src/voz/tools-servidor.ts";
import { instruccionVozCita } from "../src/voz/perfil-voz.ts";
import { APPOINTMENT_HARD_RULES, buildSystemPrompt, executeToolCall, getAgentConfig } from "../src/whatsapp/llm-turn-handler.ts";
import { buildCitasFixture } from "./fixtures.ts";

const TZ = "America/Merida"; // UTC-6 todo el anio
const LUNES = "2027-09-13";
const PHONE = "9991234567";
const lunesA = (hhmm: string) => zonedTimeToUtc(LUNES, hhmm, TZ).toISOString();

describe("local-time", () => {
  it("localTimeFields lee la zona del negocio, no la del servidor", () => {
    expect(localTimeFields("2027-09-13T15:00:00.000Z", TZ)).toEqual({ local_date: "2027-09-13", local_time: "09:00", local_weekday: "lunes", timezone: TZ });
    // 01:00Z del miercoles es martes 19:00 en Merida
    expect(localTimeFields("2027-09-15T01:00:00.000Z", TZ)).toMatchObject({ local_date: "2027-09-14", local_time: "19:00" });
    expect(localTimeFields(new Date("2027-09-13T15:00:00.000Z"), TZ).local_time).toBe("09:00");
  });
  it("localDateTimeLabel", () => {
    expect(localDateTimeLabel("2027-09-13T16:00:00.000Z", TZ)).toBe("lunes, 13 de septiembre a las 10:00");
  });
  it("isIsoInstantWithZone exige zona explicita", () => {
    for (const ok of ["2027-09-13T16:00:00.000Z", "2027-09-13T10:00:00-06:00", "2027-09-13T10:00Z"]) expect(isIsoInstantWithZone(ok)).toBe(true);
    for (const malo of ["2027-09-13T16:00:00", "2027-09-13 10:00", "Sep 13 2027 10:00", "2027-09-13", "", 5]) expect(isIsoInstantWithZone(malo)).toBe(false);
  });
});

describe("QA-citas-R1-seguridad-08 / agentes-01 / features-01 / viaje-01: las herramientas traen la hora local", () => {
  it("consultar_disponibilidad (WhatsApp y voz): cada horario trae local_time 09:00 y la zona junto al instante exacto", async () => {
    const f = buildCitasFixture();
    const input = { provider_id: f.providerId, service_id: f.serviceId, date: LUNES };
    const wa = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "consultar_disponibilidad", input });
    const slots = (wa.result as { slots: Array<Record<string, string>> }).slots;
    expect(slots[0]).toEqual({ starts_at: "2027-09-13T15:00:00.000Z", ends_at: "2027-09-13T15:30:00.000Z", local_date: LUNES, local_time: "09:00", local_weekday: "lunes", timezone: TZ });
    const voz = await ejecutarToolVozCitas({ repo: f.repo, organizationId: f.organizationId, telefono: PHONE }, "consultar_disponibilidad", input);
    expect((voz.resultado as { slots: Array<Record<string, string>> }).slots[0]).toMatchObject({ local_time: "09:00", timezone: TZ });
  });

  it("crear_cita y buscar_mis_citas devuelven la hora local de la cita (10:00)", async () => {
    const f = buildCitasFixture();
    const creada = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "crear_cita", input: { provider_id: f.providerId, service_id: f.serviceId, customer_name: "Ana", starts_at: lunesA("10:00") } });
    expect((creada.result as { appointment: Record<string, string> }).appointment).toMatchObject({ starts_at: "2027-09-13T16:00:00.000Z", local_time: "10:00", local_date: LUNES, timezone: TZ });
    const wa = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "buscar_mis_citas", input: {} });
    expect((wa.result as { appointments: Array<Record<string, string>> }).appointments[0]).toMatchObject({ local_time: "10:00", timezone: TZ });
    const voz = await ejecutarToolVozCitas({ repo: f.repo, organizationId: f.organizationId, telefono: PHONE }, "buscar_mis_citas", {});
    expect((voz.resultado as { appointments: Array<Record<string, string>> }).appointments[0]).toMatchObject({ local_time: "10:00", timezone: TZ });
  });

  it("reagendar_cita fuera de horario: alternative_slots traen la hora local", async () => {
    const f = buildCitasFixture();
    const c = await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: lunesA("10:00"), source: "whatsapp" });
    const out = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "reagendar_cita", input: { appointment_id: c.id, new_starts_at: lunesA("20:00") } });
    const alt = (out.result as { alternative_slots: Array<Record<string, string>> }).alternative_slots;
    expect(alt.length).toBeGreaterThan(0);
    expect(alt[0]).toMatchObject({ local_time: "09:00", timezone: TZ });
  });

  it("las reglas duras y la instruccion de voz explican que starts_at es UTC y que se lee local_time", () => {
    expect(APPOINTMENT_HARD_RULES).toMatch(/UTC/);
    expect(APPOINTMENT_HARD_RULES).toMatch(/local_time/);
    const voz = instruccionVozCita({ businessName: "Clinica", ahora: new Date("2027-09-10T15:00:00.000Z"), timezone: TZ });
    expect(voz).toMatch(/local_time/);
  });
});

describe("QA-citas-R1-features-02 / viaje-02: el CONTEXTO DEL CLIENTE lista las citas en hora local", () => {
  const ahora = new Date("2027-09-10T15:00:00.000Z");
  it("hora local del negocio (10:00), nunca el ISO UTC", async () => {
    const f = buildCitasFixture();
    await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: lunesA("10:00"), source: "whatsapp" });
    const customer = await lookupCitasCustomer(f.repo, f.organizationId, PHONE, ahora);
    const prompt = buildSystemPrompt(getAgentConfig(f.organizationId, TZ), customer, ahora, "dental");
    const bloque = prompt.slice(prompt.indexOf("CONTEXTO DEL CLIENTE"));
    expect(bloque).toContain("lunes, 13 de septiembre a las 10:00");
    expect(bloque).not.toContain("T16:00:00");
  });

  it("si el driver de Postgres entrega `Date`, el contexto sigue en hora local (no Date.toString del servidor)", async () => {
    const f = buildCitasFixture();
    const customer = {
      isNew: false,
      fullName: "Ana",
      upcomingAppointments: [{ appointmentId: "a1", providerName: "Dra. X", serviceName: "Limpieza", startsAt: new Date("2027-09-13T16:00:00.000Z") as unknown as string }],
    };
    const prompt = buildSystemPrompt(getAgentConfig(f.organizationId, TZ), customer, ahora, "dental");
    expect(prompt).toContain("lunes, 13 de septiembre a las 10:00");
    expect(prompt).not.toMatch(/GMT|Coordinated/);
  });

  it("lookupCitasCustomer normaliza a ISO el `Date` que entrega el driver de Postgres (recorre customers.ts, no solo el prompt)", async () => {
    const f = buildCitasFixture();
    await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: lunesA("10:00"), source: "whatsapp" });
    const conDate = new Proxy(f.repo, {
      get(target, prop, receiver) {
        if (prop === "listActiveAppointmentsForCustomer") {
          return async (...args: Parameters<typeof target.listActiveAppointmentsForCustomer>) =>
            (await target.listActiveAppointmentsForCustomer(...args)).map((r) => ({ ...r, startsAt: new Date(r.startsAt) as unknown as string }));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const customer = await lookupCitasCustomer(conDate, f.organizationId, PHONE, ahora);
    expect(customer.upcomingAppointments[0]!.startsAt).toBe("2027-09-13T16:00:00.000Z");
    expect(typeof customer.upcomingAppointments[0]!.startsAt).toBe("string");
  });

  it("lookupCitasCustomer entrega startsAt como ISO string y la zona de la sucursal", async () => {
    const f = buildCitasFixture();
    await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: lunesA("10:00"), source: "whatsapp" });
    const customer = await lookupCitasCustomer(f.repo, f.organizationId, PHONE, ahora);
    expect(customer.upcomingAppointments[0]).toMatchObject({ startsAt: "2027-09-13T16:00:00.000Z", timeZone: TZ });
  });
});

describe("QA-citas-R1-features-03: un starts_at sin zona ya no se interpreta en la zona del servidor", () => {
  // Servidor en UTC (como Vercel): vi.stubEnv fija TZ y lo restaura (sin leer la variable directamente: el guard de inventario de entorno la veria como credencial).
  beforeEach(() => {
    vi.stubEnv("TZ", "UTC");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("crear_cita con '2027-09-13T16:00:00' (sin zona) devuelve error de validacion y no agenda nada", async () => {
    const f = buildCitasFixture();
    const out = await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "crear_cita", input: { provider_id: f.providerId, service_id: f.serviceId, customer_name: "Ana", starts_at: "2027-09-13T16:00:00" } });
    expect(out.result).toMatchObject({ error: expect.stringContaining("zona") });
    expect(out.appointmentId).toBeNull();
    const { appointments } = (await executeToolCall(f.repo, { organizationId: f.organizationId, phone: PHONE, name: "buscar_mis_citas", input: {} })).result as { appointments: unknown[] };
    expect(appointments).toHaveLength(0);
  });

  it("formatos ambiguos ('2027-09-13 10:00', 'Sep 13 2027 10:00') tambien se rechazan, en crear y en reagendar", async () => {
    const f = buildCitasFixture();
    const base = { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, source: "whatsapp" as const };
    for (const startsAt of ["2027-09-13 10:00", "Sep 13 2027 10:00"]) {
      await expect(createAppointment(f.repo, { ...base, startsAt })).rejects.toBeInstanceOf(AppointmentValidationError);
    }
    const c = await createAppointment(f.repo, { ...base, startsAt: lunesA("10:00") });
    await expect(rescheduleAppointment(f.repo, { organizationId: f.organizationId, appointmentId: c.id, newStartsAt: "2027-09-13T11:00:00" })).rejects.toBeInstanceOf(AppointmentValidationError);
  });

  it("el alta manual del panel tambien rechaza un starts_at sin zona y acepta uno con zona", async () => {
    const f = buildCitasFixture();
    const base = { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE };
    await expect(createAppointmentFromPanel(f.repo, { ...base, startsAt: "2027-09-13T10:00:00" })).rejects.toBeInstanceOf(AppointmentValidationError);
    const ok = await createAppointmentFromPanel(f.repo, { ...base, startsAt: "2027-09-13T10:00:00-06:00" });
    expect(new Date(ok.startsAt).toISOString()).toBe("2027-09-13T16:00:00.000Z");
  });

  it("con zona explicita (Z u offset) se agenda a la hora local correcta", async () => {
    const f = buildCitasFixture();
    const a = await createAppointment(f.repo, { organizationId: f.organizationId, providerId: f.providerId, serviceId: f.serviceId, customerName: "Ana", customerPhone: PHONE, startsAt: "2027-09-13T10:00:00-06:00", source: "whatsapp" });
    expect(new Date(a.startsAt).toISOString()).toBe("2027-09-13T16:00:00.000Z");
  });
});

describe("QA-citas-R1-automatizacion-04 / viaje-09: la lista de espera compara el dia LOCAL del hueco", () => {
  const sembrar = (repo: ReturnType<typeof buildCitasFixture>["repo"], organizationId: string, desde: string, hasta: string, ventana: "morning" | "afternoon" | "evening" | "any") =>
    repo.seedWaitlistEntry({ organizationId, customerPhone: "9995500001", customerName: "Espera", providerId: null, serviceId: null, preferredDateFrom: desde, preferredDateTo: hasta, preferredTimeWindow: ventana });

  it("hueco del 21 a las 18:30 de Merida (00:30Z del 22) se ofrece a quien pidio el 21", async () => {
    const { repo, organizationId, providerId } = buildCitasFixture();
    sembrar(repo, organizationId, "2026-10-21", "2026-10-21", "evening");
    const r = await runOptimizadorCore(repo, organizationId, TZ, { providerId, startsAt: zonedTimeToUtc("2026-10-21", "18:30", TZ).toISOString() });
    expect(r.matched).toBe(true);
  });

  it("el mismo hueco NO se ofrece a quien solo pidio el 22", async () => {
    const { repo, organizationId, providerId } = buildCitasFixture();
    sembrar(repo, organizationId, "2026-10-22", "2026-10-22", "any");
    const r = await runOptimizadorCore(repo, organizationId, TZ, { providerId, startsAt: zonedTimeToUtc("2026-10-21", "18:30", TZ).toISOString() });
    expect(r.matched).toBe(false);
  });
});
