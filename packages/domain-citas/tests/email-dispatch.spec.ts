// Pruebas del motor de envío real (fail-closed) de correo — port de
// citas-reservaciones/supabase/functions/_shared/email-dispatch-core.test.ts +
// el comportamiento de lote de messaging-dispatcher/index.ts (la parte de
// correo), sobre CitasRepository en vez de supabase-js. `sendEmailOutboxJob`
// recibe `fetchImpl` inyectado (nunca toca la red real, nunca un mock global).
import { describe, expect, it } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { tryEnqueueAppointmentEmail } from "../src/appointment-email-notifications.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "../src/email-dispatch.ts";
import type { EmailOutboxJobRow } from "../src/repository.ts";
import { buildCitasFixture } from "./fixtures.ts";

/** Lunes real dentro del horario 9-17h America/Merida que buildCitasFixture
 * siembra (ver fixtures.ts) — un slot real, nunca "ahora + 1h" (que puede caer
 * fuera de horario o fuera del grid de 30 min). */
const VALID_STARTS_AT = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();

function fakeJob(overrides: Partial<EmailOutboxJobRow> = {}): EmailOutboxJobRow {
  return { id: "job-1", organizationId: "org-1", attempts: 1, payload: { to: "cliente@example.com", subject: "Asunto", html: "<p>hola</p>", text: "hola" }, ...overrides };
}

describe("sendEmailOutboxJob", () => {
  it("fail-closed: sin RESEND_API_KEY, SIEMPRE lanza (nunca finge éxito)", async () => {
    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      return new Response("no debería llegar aquí", { status: 200 });
    }) as typeof fetch;

    await expect(sendEmailOutboxJob(fetchImpl, fakeJob(), { apiKey: null, from: "atiende <notificaciones@atiende.ai>" })).rejects.toThrow(/Resend API key unavailable/);
    expect(fetchCalled).toBe(false); // ni siquiera intenta la red sin API key real.
  });

  it("lanza si el payload no trae destinatario real", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await expect(sendEmailOutboxJob(fetchImpl, fakeJob({ payload: { subject: "x", html: "<p>x</p>" } }), { apiKey: "re_test_key", from: "a@b.com" })).rejects.toThrow(/recipient/);
  });

  it("lanza si el payload no trae subject/html reales", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await expect(sendEmailOutboxJob(fetchImpl, fakeJob({ payload: { to: "x@y.com" } }), { apiKey: "re_test_key", from: "a@b.com" })).rejects.toThrow(/email content/);
  });

  it("con API key real, manda el request REAL a Resend con Idempotency-Key estable por job", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "resend-id-1" }), { status: 200 });
    }) as typeof fetch;

    await sendEmailOutboxJob(fetchImpl, fakeJob({ id: "job-real-1" }), { apiKey: "re_test_key", from: "atiende <notificaciones@atiende.ai>" });

    expect(capturedUrl).toBe("https://api.resend.com/emails");
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Idempotency-Key"]).toBe("outbox/job-real-1");
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.to).toBe("cliente@example.com");
    expect(body.subject).toBe("Asunto");
    expect(body.html).toBe("<p>hola</p>");
  });

  it("Resend respondiendo error HTTP lanza con el detalle real (nunca finge éxito)", async () => {
    const fetchImpl = (async () => new Response("API key inválida", { status: 401 })) as typeof fetch;
    await expect(sendEmailOutboxJob(fetchImpl, fakeJob(), { apiKey: "re_bad_key", from: "a@b.com" })).rejects.toThrow(/401/);
  });
});

describe("dispatchPendingEmailJobs", () => {
  it("fix a2b (CRÍTICO): sin RESEND_API_KEY, NO reclama nada — cero intentos quemados, el job queda intacto en 'pending'", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente Correo", customerPhone: "9991112222", customerEmail: "cliente@example.com", startsAt: VALID_STARTS_AT, source: "web" });
    await tryEnqueueAppointmentEmail(fixture.repo, fixture.organizationId, "appointment.created", appointment.id);
    const attemptsBefore = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.created")?.attempts ?? 0;

    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: null, from: "a@b.com" });

    expect(summary.notConfigured).toBe(true);
    expect(summary.processed).toBe(0);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.dead).toBe(0);
    // El punto central del fix: SIN proveedor configurado, `claimEmailOutboxBatch`
    // (cross-tenant, cuenta intento) nunca se llama -- el job sigue 'pending' con
    // el mismo `attempts` de antes (antes de este fix, 5 corridas sin key
    // bastaban para dejarlo 'dead' sin que Resend jamás lo hubiera visto).
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.created");
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(attemptsBefore);
  });

  it("con RESEND_API_KEY real (fetch fake exitoso): marca 'sent' de verdad", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente Correo", customerPhone: "9991112222", customerEmail: "cliente@example.com", startsAt: VALID_STARTS_AT, source: "web" });
    await tryEnqueueAppointmentEmail(fixture.repo, fixture.organizationId, "appointment.created", appointment.id);

    const fetchImpl = (async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })) as typeof fetch;
    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });

    expect(summary.notConfigured).toBe(false);
    expect(summary.sent).toBe(1);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.created");
    expect(job?.status).toBe("sent");
  });

  it("agota los reintentos reales y termina en 'dead' tras MAX_EMAIL_DISPATCH_ATTEMPTS (con proveedor configurado, Resend siempre en error)", async () => {
    const fixture = buildCitasFixture();
    const appointment = await createAppointment(fixture.repo, { organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Cliente Correo", customerPhone: "9991112222", customerEmail: "cliente@example.com", startsAt: VALID_STARTS_AT, source: "web" });
    await tryEnqueueAppointmentEmail(fixture.repo, fixture.organizationId, "appointment.created", appointment.id);
    const fetchImpl = (async () => new Response("Resend caído", { status: 500 })) as typeof fetch;

    let lastSummary;
    for (let i = 0; i < MAX_EMAIL_DISPATCH_ATTEMPTS; i++) {
      lastSummary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    }
    expect(lastSummary!.dead).toBe(1);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "appointment.created");
    expect(job?.status).toBe("dead");

    // Un job 'dead' nunca se vuelve a reclamar en corridas futuras.
    const afterDead = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    expect(afterDead.processed).toBe(0);
  });

  it("nunca toca una fila channel='whatsapp' del mismo outbox", async () => {
    const fixture = buildCitasFixture();
    await fixture.repo.enqueueMessagingOutbox(fixture.organizationId, "whatsapp", "appointment.reminder_24h", "reminder-24h:some-id", { to: "5599998888", body: "recordatorio" });

    const fetchImpl = (async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })) as typeof fetch;
    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    expect(summary.processed).toBe(0);
    const whatsappJob = fixture.repo.getOutbox().find((o) => o.channel === "whatsapp");
    expect(whatsappJob?.status).toBe("pending"); // nunca tocado por el dispatcher de correo.
  });
});
