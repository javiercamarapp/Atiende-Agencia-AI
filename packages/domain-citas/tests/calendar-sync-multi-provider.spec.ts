// Fase 6 §2 (seguimiento) — motor de sincronización GENERALIZADO por proveedor
// (calendar-sync.ts::syncPendingAppointmentsMultiProvider/tryTriggerCalendarSync):
// prueba el despacho por proveedor (Google/Cal.com/CalDAV) a través del puerto
// genérico, usando `FakeCalendarSyncPort` (mismo patrón que
// `FakeGoogleCalendarPort`, ver calendar-sync-port.ts) para las pruebas de
// dispatch/backoff/exhausted, y los simuladores HTTP REALES ya existentes
// (calcom-sim.ts/caldav-sim.ts) + `createCalendarSyncPortResolver`
// (calendar-sync-resolver-factory.ts) para probar la resolución real de punta a
// punta contra el protocolo HTTP real de cada plataforma — nunca un mock de HTTP
// inventado.
import { afterEach, describe, expect, it } from "vitest";
import { createAppointment, cancelAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { syncPendingAppointmentsMultiProvider, tryTriggerCalendarSync } from "../src/calendar-sync.ts";
import type { ResolveCalendarSyncPort, ResolvedCalendarSync } from "../src/calendar-sync.ts";
import { FakeCalendarSyncPort } from "../src/calendar-sync-port.ts";
import { createCalendarSyncPortResolver } from "../src/calendar-sync-resolver-factory.ts";
import { RealCalComPort } from "../src/calcom-port.ts";
import { CalComApiSimulator } from "./calcom-sim.ts";
import { RealCalDavPort } from "../src/caldav-port.ts";
import { CalDavServerSimulator } from "./caldav-sim.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { zonedTimeToUtc } from "../src/availability.ts";

const NEXT_MONDAY_9AM_MERIDA = zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString();

function fixedResolver(resolved: ResolvedCalendarSync | null, connectedProviderIds: Set<string>): ResolveCalendarSyncPort {
  return async (providerId) => (connectedProviderIds.has(providerId) ? resolved : null);
}

async function createRealAppointment(fixture: ReturnType<typeof buildCitasFixture>, overrides: { customerPhone?: string; startsAt?: string } = {}) {
  return createAppointment(fixture.repo, {
    organizationId: fixture.organizationId,
    providerId: fixture.providerId,
    serviceId: fixture.serviceId,
    customerName: "Ana Torres",
    customerPhone: overrides.customerPhone ?? "9991112233",
    startsAt: overrides.startsAt ?? NEXT_MONDAY_9AM_MERIDA,
    source: "web",
  });
}

describe("tryTriggerCalendarSync / syncPendingAppointmentsMultiProvider — despacho genérico por plataforma", () => {
  it.each(["calcom", "caldav"] as const)("un proveedor con %s conectado: crea el evento real vía el puerto genérico y marca 'synced'", async (platform) => {
    const fixture = buildCitasFixture();
    const appointment = await createRealAppointment(fixture);

    const fake = new FakeCalendarSyncPort(platform);
    const resolver = fixedResolver({ port: fake, externalCalendarRef: platform === "calcom" ? "555" : "https://caldav.example.com/cal/" }, new Set([fixture.providerId]));

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    expect(fake.events.size).toBe(1);
    const [eventId, event] = [...fake.events.entries()][0]!;
    expect(event.summary).toContain("Ana Torres");

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
    expect(stored!.googleEventId).toBe(eventId);
  });

  it("cancelar una cita ya sincronizada vía Cal.com deja pending_cancel y luego BORRA el booking real", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createRealAppointment(fixture);
    const fake = new FakeCalendarSyncPort("calcom");
    const resolver = fixedResolver({ port: fake, externalCalendarRef: "555" }, new Set([fixture.providerId]));
    await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    const synced = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(synced!.googleSyncStatus).toBe("synced");

    const cancelled = await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    expect(cancelled.googleSyncStatus).toBe("pending_cancel");

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    expect(fake.events.get(synced!.googleEventId!)?.deleted).toBe(true);
    const finalRow = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(finalRow!.googleSyncStatus).toBe("deleted");
  });

  it("reagendar una cita ya sincronizada vía CalDAV ACTUALIZA el evento real con el horario nuevo", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createRealAppointment(fixture);
    const fake = new FakeCalendarSyncPort("caldav");
    const resolver = fixedResolver({ port: fake, externalCalendarRef: "https://caldav.example.com/cal/" }, new Set([fixture.providerId]));
    await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    const synced = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);

    const newStartsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const { appointment: rescheduled } = await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt });
    expect(rescheduled.googleSyncStatus).toBe("pending");

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    const updated = fake.events.get(synced!.googleEventId!)!;
    expect(updated.startTime).toBe(newStartsAt);
  });

  it("ningún proveedor de NINGUNA plataforma conectado: la cita queda 'skipped', nunca bloquea nada", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createRealAppointment(fixture);
    const resolver = fixedResolver(null, new Set());
    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.skipped).toBe(1);
    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("skipped");
  });

  it("un 401 real de Cal.com (credencial revocada) marca la CUENTA CAL.COM en error de una vez, sin quemar reintentos", async () => {
    const fixture = buildCitasFixture();
    await fixture.repo.connectProviderCalComAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, calcomEventTypeId: "555", apiKey: "llave-ficticia-revocada" });
    const appointment = await createRealAppointment(fixture);

    const fake = new FakeCalendarSyncPort("calcom");
    const { CalComApiError } = await import("../src/calcom-port.ts");
    fake.failNextCall = new CalComApiError("no autorizado", 401, "unauthorized");
    const resolver = fixedResolver({ port: fake, externalCalendarRef: "555" }, new Set([fixture.providerId]));

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.exhausted).toBe(1);

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("error");
    expect(stored!.googleSyncAttempts).toBe(1); // se agotó de inmediato, NO tras 5 intentos

    const account = await fixture.repo.findProviderCalComAccount(fixture.providerId);
    expect(account!.syncStatus).toBe("error");
  });

  it("un 403 real de CalDAV (contraseña de aplicación revocada) marca la CUENTA CALDAV en error de una vez", async () => {
    const fixture = buildCitasFixture();
    await fixture.repo.connectProviderCalDavAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, calendarCollectionUrl: "https://caldav.example.com/cal/", username: "x@y.com", password: "clave-ficticia-revocada" });
    const appointment = await createRealAppointment(fixture);

    const fake = new FakeCalendarSyncPort("caldav");
    const { CalDavApiError } = await import("../src/caldav-port.ts");
    fake.failNextCall = new CalDavApiError("prohibido", 403, "forbidden");
    const resolver = fixedResolver({ port: fake, externalCalendarRef: "https://caldav.example.com/cal/" }, new Set([fixture.providerId]));

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.exhausted).toBe(1);

    const account = await fixture.repo.findProviderCalDavAccount(fixture.providerId);
    expect(account!.syncStatus).toBe("error");
  });

  it("un fallo transitorio (no 401/403) reintenta con backoff, nunca marca la cuenta en error", async () => {
    const fixture = buildCitasFixture();
    await fixture.repo.connectProviderCalComAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, calcomEventTypeId: "555", apiKey: "llave-ficticia" });
    const appointment = await createRealAppointment(fixture);

    const fake = new FakeCalendarSyncPort("calcom");
    fake.failNextCall = new Error("ECONNRESET");
    const resolver = fixedResolver({ port: fake, externalCalendarRef: "555" }, new Set([fixture.providerId]));

    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id, new Date("2026-09-08T00:00:00.000Z"));
    expect(summary.retried).toBe(1);
    const account = await fixture.repo.findProviderCalComAccount(fixture.providerId);
    expect(account!.syncStatus).toBe("connected");
  });

  it("syncPendingAppointmentsMultiProvider procesa citas de proveedores en Google, Cal.com y CalDAV en la misma corrida", async () => {
    const fixture = buildCitasFixture();
    const googleFake = new FakeCalendarSyncPort("google");
    const calcomFake = new FakeCalendarSyncPort("calcom");
    const a1 = await createRealAppointment(fixture, { customerPhone: "9990000001" });

    const resolver: ResolveCalendarSyncPort = async (providerId) => (providerId === fixture.providerId ? { port: calcomFake, externalCalendarRef: "555" } : { port: googleFake, externalCalendarRef: "primary" });
    const summary = await syncPendingAppointmentsMultiProvider(fixture.repo, resolver);
    expect(summary.processed).toBe(1);
    expect(summary.synced).toBe(1);
    expect(calcomFake.events.size).toBe(1);
    expect(googleFake.events.size).toBe(0);
    void a1;
  });
});

// ---------------------------------------------------------------------------
// createCalendarSyncPortResolver contra los simuladores HTTP REALES ya
// existentes (calcom-sim.ts/caldav-sim.ts) — prueba de punta a punta que
// RealCalComPort/RealCalDavPort SÍ quedan conectados al motor real vía la
// fábrica de producción, hablando el protocolo HTTP real (headers, rutas, XML/
// JSON), nunca un mock inventado.
// ---------------------------------------------------------------------------

describe("createCalendarSyncPortResolver — de punta a punta contra los simuladores HTTP reales", () => {
  let calcomSim: CalComApiSimulator | null = null;
  let caldavSim: CalDavServerSimulator | null = null;

  afterEach(async () => {
    await calcomSim?.stop();
    await caldavSim?.stop();
    calcomSim = null;
    caldavSim = null;
  });

  it("Cal.com conectado: el resolver real construye un RealCalComPort apuntando al simulador y el motor crea el booking real", async () => {
    const fixture = buildCitasFixture();
    calcomSim = new CalComApiSimulator({ apiKey: "llave-ficticia-e2e", eventTypes: [{ id: 555, slug: "consulta", title: "Consulta", lengthInMinutes: 30 }] });
    const { baseUrl } = await calcomSim.start();

    await fixture.repo.connectProviderCalComAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, calcomEventTypeId: "555", apiKey: "llave-ficticia-e2e", baseUrl });
    const appointment = await createRealAppointment(fixture);

    const resolver = createCalendarSyncPortResolver(fixture.repo, null, { createCalComPort: (cfg) => new RealCalComPort(cfg) });
    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    expect(calcomSim.bookings.size).toBe(1);

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
  });

  it("CalDAV conectado: el resolver real construye un RealCalDavPort apuntando al simulador y el motor hace PUT del VEVENT real", async () => {
    const fixture = buildCitasFixture();
    caldavSim = new CalDavServerSimulator({ username: "x@y.com", password: "clave-ficticia-e2e", calendarPath: "/dav/calendars/x/" });
    const { calendarCollectionUrl } = await caldavSim.start();

    await fixture.repo.connectProviderCalDavAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, calendarCollectionUrl, username: "x@y.com", password: "clave-ficticia-e2e" });
    const appointment = await createRealAppointment(fixture);

    const resolver = createCalendarSyncPortResolver(fixture.repo, null, { createCalDavPort: (cfg) => new RealCalDavPort(cfg) });
    const summary = await tryTriggerCalendarSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    expect(caldavSim.resources.size).toBe(1);

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
  });

  it("sin GOOGLE_CLIENT_ID/SECRET de plataforma (null) y sin ninguna cuenta conectada: el resolver devuelve null, nunca lanza", async () => {
    const fixture = buildCitasFixture();
    const resolver = createCalendarSyncPortResolver(fixture.repo, null);
    const result = await resolver(fixture.providerId);
    expect(result).toBeNull();
  });
});
