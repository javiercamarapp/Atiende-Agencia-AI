// Motor de sincronización real (calendar-sync.ts) sobre InMemoryCitasRepository +
// FakeGoogleCalendarPort — ver diseño Fase 3 §5/§6/§8. El caso más importante de
// esta suite es "un fallo de Google Calendar NUNCA rompe la operación real de
// dominio" (tryTriggerGoogleSync es best-effort, nunca lanza).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancelAppointment, createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { MAX_SYNC_ATTEMPTS, nextSyncBackoffMs, syncPendingAppointments, tryTriggerGoogleSync } from "../src/calendar-sync.ts";
import { FakeGoogleCalendarPort, GoogleCalendarApiError } from "../src/google-calendar-port.ts";
import type { ResolveCalendarPort } from "../src/calendar-sync.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { zonedTimeToUtc } from "../src/availability.ts";

const NEXT_MONDAY_9AM_MERIDA = zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString(); // lunes real

function fixedResolver(port: FakeGoogleCalendarPort, connectedProviderIds: Set<string>): ResolveCalendarPort {
  return async (providerId) => (connectedProviderIds.has(providerId) ? port : null);
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

describe("tryTriggerGoogleSync — intento inmediato best-effort tras crear una cita", () => {
  it("un proveedor SIN Google Calendar conectado: la cita queda 'skipped', nunca bloquea nada", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createRealAppointment(fixture);
    expect(appointment.googleSyncStatus).toBe("pending");

    const port = new FakeGoogleCalendarPort();
    const summary = await tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set()), appointment.id);

    expect(summary.skipped).toBe(1);
    expect(port.events.size).toBe(0);
    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("skipped");
  });

  it("un proveedor CON Google Calendar conectado: crea el evento real y marca 'synced' con el eventId", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "doctora@example.com", refreshToken: "rt-real" });
    const appointment = await createRealAppointment(fixture);

    const port = new FakeGoogleCalendarPort();
    const summary = await tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set([fixture.providerId])), appointment.id);

    expect(summary.synced).toBe(1);
    expect(port.events.size).toBe(1);
    const [eventId, event] = [...port.events.entries()][0]!;
    expect(event.calendarId).toBe("doctora@example.com");
    expect(event.summary).toContain("Ana Torres");

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("synced");
    expect(stored!.googleEventId).toBe(eventId);
    expect(stored!.googleSyncAttempts).toBe(1);
  });

  it("cancelar una cita YA sincronizada deja pending_cancel y luego BORRA el evento real", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    const resolver = fixedResolver(port, new Set([fixture.providerId]));
    await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    const synced = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(synced!.googleSyncStatus).toBe("synced");

    const cancelled = await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    expect(cancelled.googleSyncStatus).toBe("pending_cancel");
    expect(cancelled.googleEventId).toBe(synced!.googleEventId); // el eventId se conserva hasta que se confirma el borrado

    const summary = await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1); // "synced" en el summary = la sincronización tuvo éxito (aquí, un borrado)
    expect(port.events.get(synced!.googleEventId!)?.deleted).toBe(true);

    const finalRow = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(finalRow!.googleSyncStatus).toBe("deleted");
  });

  it("cancelar una cita que NUNCA se sincronizó (nunca tuvo googleEventId) queda 'skipped', nunca 'pending_cancel'", async () => {
    const fixture = buildCitasFixture();
    // Sin conectar ningún calendario -> la cita se queda en 'pending' hasta que se cancela.
    const appointment = await createRealAppointment(fixture);
    const cancelled = await cancelAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id });
    expect(cancelled.googleSyncStatus).toBe("skipped");
  });

  it("reagendar una cita YA sincronizada vuelve a 'pending' y ACTUALIZA el evento real con el horario nuevo", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    const resolver = fixedResolver(port, new Set([fixture.providerId]));
    await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    const synced = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);

    const newStartsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();
    const { appointment: rescheduled } = await rescheduleAppointment(fixture.repo, { organizationId: fixture.organizationId, appointmentId: appointment.id, newStartsAt });
    expect(rescheduled.googleSyncStatus).toBe("pending");
    expect(rescheduled.googleEventId).toBe(synced!.googleEventId);

    const summary = await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    expect(summary.synced).toBe(1);
    const updatedEvent = port.events.get(synced!.googleEventId!)!;
    expect(updatedEvent.startTime).toBe(newStartsAt);

    const finalRow = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(finalRow!.googleSyncStatus).toBe("synced");
  });

  // ==========================================================================
  // El caso más importante de todo Fase 3: un fallo de Google Calendar NUNCA
  // rompe la operación real de dominio (crear/cancelar/reagendar la cita real ya
  // sucedió; el best-effort de después nunca puede deshacerlo ni lanzar).
  // ==========================================================================
  it("un fallo de Google Calendar (red caída, 500, lo que sea) NUNCA lanza — la cita real ya existe y queda con backoff para reintentar", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    expect(appointment.status).toBe("pending"); // la cita real YA existe, sin importar qué pase después

    const port = new FakeGoogleCalendarPort();
    port.failNextCall = new Error("ECONNRESET: Google Calendar no respondió");

    // No debe lanzar — best-effort real.
    const summary = await expect(tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set([fixture.providerId])), appointment.id, new Date("2026-09-08T00:00:00.000Z"))).resolves.toBeDefined();
    void summary;

    // La cita real sigue existiendo, pendiente e intacta — el fallo de Google no la tocó.
    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.status).toBe("pending");
    expect(stored!.googleSyncStatus).toBe("pending"); // sigue pendiente -> el cron la reintentará
    expect(stored!.googleSyncAttempts).toBe(1);
    expect(stored!.googleSyncError).toContain("ECONNRESET");
    expect(stored!.googleSyncNextRetryAt).not.toBeNull();
  });

  it("después de MAX_SYNC_ATTEMPTS fallos consecutivos, la cita queda en 'error' (visible internamente) y deja de reintentarse — pero la cita real sigue viva", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    const resolver = fixedResolver(port, new Set([fixture.providerId]));

    let now = new Date("2026-09-08T00:00:00.000Z");
    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      port.failNextCall = new Error(`fallo intento ${attempt}`);
      await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id, now);
      now = new Date(now.getTime() + nextSyncBackoffMs(attempt) + 1000);
    }

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("error");
    expect(stored!.googleSyncAttempts).toBe(MAX_SYNC_ATTEMPTS);
    expect(stored!.googleSyncNextRetryAt).toBeNull(); // ya no se reintenta más
    expect(stored!.status).toBe("pending"); // la cita real NUNCA se tocó por esto

    // Una reconciliación posterior no vuelve a tocarla (ya agotó los intentos).
    const summary = await syncPendingAppointments(fixture.repo, resolver, { now });
    expect(summary.processed).toBe(0);
  });

  it("invalid_grant (el proveedor revocó el acceso) marca la CUENTA en error de una vez, sin quemar reintentos de backoff", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt-revocado" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    port.failNextCall = new GoogleCalendarApiError("no se pudo refrescar", 400, JSON.stringify({ error: "invalid_grant" }));

    const summary = await tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set([fixture.providerId])), appointment.id);
    expect(summary.exhausted).toBe(1);

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("error");
    expect(stored!.googleSyncAttempts).toBe(1); // se agotó de inmediato, NO tras 5 intentos

    const account = await fixture.repo.findProviderCalendarAccount(fixture.providerId);
    expect(account!.syncStatus).toBe("error");
  });

  // Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — un 400 real que NO es
  // invalid_grant (rechazo de VALIDACIÓN, no de credencial) nunca debe reintentarse
  // a ciegas hasta agotar MAX_SYNC_ATTEMPTS -- se detiene de inmediato con
  // google_sync_status='invalid', sin tocar la cuenta (la credencial sigue
  // sirviendo).
  it("un 400 real que NO es invalid_grant (rechazo de validación) queda 'invalid' de inmediato, sin tocar la cuenta", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    port.failNextCall = new GoogleCalendarApiError("Google Calendar API error en /calendars/primary/events", 400, JSON.stringify({ error: { message: "Invalid time range." } }));

    const summary = await tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set([fixture.providerId])), appointment.id);
    expect(summary.invalid).toBe(1);
    expect(summary.exhausted).toBe(0);

    const stored = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, appointment.id);
    expect(stored!.googleSyncStatus).toBe("invalid");
    expect(stored!.googleSyncAttempts).toBe(1); // se detuvo de inmediato, NO tras 5 intentos
    // El mensaje semántico real (Invalid time range.) sí queda -- el envelope JSON
    // completo NUNCA se reproduce estructuralmente (ver extractProviderMessage).
    expect(stored!.googleSyncError).toBe("Google Calendar rechazó esta cita (código 400): Invalid time range.");
    expect(stored!.googleSyncError).not.toContain("{");

    const account = await fixture.repo.findProviderCalendarAccount(fixture.providerId);
    expect(account!.syncStatus).toBe("connected"); // la credencial sigue sirviendo -- nunca se toca por esto
  });

  it("una cita ya 'synced' (no pending/pending_cancel) no se vuelve a tocar — tryTriggerGoogleSync es un no-op", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    const resolver = fixedResolver(port, new Set([fixture.providerId]));
    await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    expect(port.calls).toHaveLength(1);

    // Reintentar el mismo trigger sobre una cita YA 'synced' no debe volver a llamar a Google.
    await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id);
    expect(port.calls).toHaveLength(1);
  });

  it("un appointmentId inexistente es un no-op silencioso, nunca lanza", async () => {
    const fixture = buildCitasFixture();
    const port = new FakeGoogleCalendarPort();
    await expect(tryTriggerGoogleSync(fixture.repo, fixedResolver(port, new Set()), randomUUID())).resolves.toEqual({ processed: 0, synced: 0, retried: 0, exhausted: 0, invalid: 0, skipped: 0, errors: [] });
  });
});

describe("syncPendingAppointments — reconciliación por lote (cron)", () => {
  it("procesa varias citas pendientes de distintos proveedores en una sola corrida", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const a1 = await createRealAppointment(fixture, { customerPhone: "9990000001", startsAt: zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString() });
    const a2 = await createRealAppointment(fixture, { customerPhone: "9990000002", startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString() });

    const port = new FakeGoogleCalendarPort();
    const summary = await syncPendingAppointments(fixture.repo, fixedResolver(port, new Set([fixture.providerId])));

    expect(summary.processed).toBe(2);
    expect(summary.synced).toBe(2);
    expect(port.events.size).toBe(2);
    const rowA1 = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, a1.id);
    const rowA2 = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, a2.id);
    expect(rowA1!.googleSyncStatus).toBe("synced");
    expect(rowA2!.googleSyncStatus).toBe("synced");
  });

  it("respeta el backoff: una cita con next_retry_at en el futuro NO se reintenta todavía", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const appointment = await createRealAppointment(fixture);
    const port = new FakeGoogleCalendarPort();
    const resolver = fixedResolver(port, new Set([fixture.providerId]));
    const now = new Date("2026-09-08T00:00:00.000Z");
    port.failNextCall = new Error("fallo transitorio");
    await tryTriggerGoogleSync(fixture.repo, resolver, appointment.id, now);

    // Todavía dentro de la ventana de backoff (nextSyncBackoffMs(1) = 2 minutos tras el primer fallo).
    const tooSoon = await syncPendingAppointments(fixture.repo, resolver, { now: new Date(now.getTime() + 10_000) });
    expect(tooSoon.processed).toBe(0);

    // Después del backoff, sí se reintenta y esta vez sí sincroniza.
    const afterBackoff = await syncPendingAppointments(fixture.repo, resolver, { now: new Date(now.getTime() + nextSyncBackoffMs(1) + 1000) });
    expect(afterBackoff.processed).toBe(1);
    expect(afterBackoff.synced).toBe(1);
  });

  it("una fila con datos raros de un proveedor no tumba la corrida completa de las demás", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const a1 = await createRealAppointment(fixture, { customerPhone: "9990000003", startsAt: zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString() });
    const a2 = await createRealAppointment(fixture, { customerPhone: "9990000004", startsAt: zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString() });

    const port = new FakeGoogleCalendarPort();
    // Solo la PRIMERA llamada (la de a1, procesada primero por orden de creación) falla.
    port.failNextCall = new Error("fallo solo en la primera");
    const summary = await syncPendingAppointments(fixture.repo, fixedResolver(port, new Set([fixture.providerId])));

    expect(summary.processed).toBe(2);
    expect(summary.retried).toBe(1);
    expect(summary.synced).toBe(1);
    const rowA1 = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, a1.id);
    const rowA2 = await fixture.repo.findAppointmentForOrganization(fixture.organizationId, a2.id);
    expect(rowA1!.googleSyncStatus).toBe("pending"); // seguirá reintentándose
    expect(rowA2!.googleSyncStatus).toBe("synced");
  });
});
