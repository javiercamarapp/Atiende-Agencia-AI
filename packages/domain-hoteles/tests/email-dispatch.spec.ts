// Pruebas del motor de envío real (fail-closed) de correo — mismo patrón que
// packages/domain-citas/tests/email-dispatch.spec.ts. `sendEmailOutboxJob` recibe
// `fetchImpl` inyectado (nunca toca la red real, nunca un mock global).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "../src/in-memory-repository.ts";
import { tryEnqueueGuestEmail } from "../src/guest-email-notifications.ts";
import { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "../src/email-dispatch.ts";
import type { EmailOutboxJobRow } from "../src/repository.ts";
import type { NewReservationInput } from "../src/types.ts";

function fakeJob(overrides: Partial<EmailOutboxJobRow> = {}): EmailOutboxJobRow {
  return { id: "job-1", propertyId: "prop-1", organizationId: "org-1", attempts: 1, payload: { to: "huesped@example.com", subject: "Asunto", html: "<p>hola</p>", text: "hola" }, ...overrides };
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
    expect(body.to).toBe("huesped@example.com");
    expect(body.subject).toBe("Asunto");
    expect(body.html).toBe("<p>hola</p>");
  });

  it("Resend respondiendo error HTTP lanza con el detalle real (nunca finge éxito)", async () => {
    const fetchImpl = (async () => new Response("API key inválida", { status: 401 })) as typeof fetch;
    await expect(sendEmailOutboxJob(fetchImpl, fakeJob(), { apiKey: "re_bad_key", from: "a@b.com" })).rejects.toThrow(/401/);
  });
});

function buildFixture() {
  const repo = new InMemoryHotelesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const guestId = randomUUID();

  repo.seedPropertySummary(organizationId, { propertyId, name: "Hotel de Prueba" });
  repo.seedTaxConfig(propertyId, { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500 });
  repo.seedRoomType(propertyId, roomTypeId, { name: "Habitación Doble", maxOccupancy: 2 });
  repo.seedGuest({ id: guestId, propertyId, fullName: "Cliente Correo", email: "cliente@example.com", phone: "9991112222" });

  return { repo, organizationId, propertyId, roomTypeId, guestId };
}

async function seedReservationAndEnqueue(fixture: ReturnType<typeof buildFixture>) {
  const input: NewReservationInput = {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    roomTypeId: fixture.roomTypeId,
    guestId: fixture.guestId,
    checkInDate: "2026-12-01",
    checkOutDate: "2026-12-03",
    totalAmount: 3000,
    idempotencyKey: null,
  };
  const reservation = await fixture.repo.insertReservation(input);
  await tryEnqueueGuestEmail(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", reservation.id);
  return reservation;
}

describe("dispatchPendingEmailJobs", () => {
  it("fix a2b (CRÍTICO): sin RESEND_API_KEY, NO reclama nada — cero intentos quemados, el job queda intacto en 'pending'", async () => {
    const fixture = buildFixture();
    await seedReservationAndEnqueue(fixture);
    const before = fixture.repo.getOutbox().find((o) => o.eventType === "reservation.created");
    expect(before?.status).toBe("pending");
    const attemptsBefore = before?.attempts ?? 0;

    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: null, from: "a@b.com" });

    expect(summary.notConfigured).toBe(true);
    expect(summary.processed).toBe(0);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.dead).toBe(0);
    // El punto central del fix: SIN proveedor configurado, `claimEmailOutboxBatch`
    // (cross-tenant, cuenta intento) nunca se llama -- el job sigue 'pending' con
    // el mismo `attempts` de antes, listo para procesarse en cuanto se configure
    // RESEND_API_KEY (antes de este fix, 5 corridas sin key bastaban para dejarlo
    // 'dead' sin que Resend jamás lo hubiera visto).
    const after = fixture.repo.getOutbox().find((o) => o.eventType === "reservation.created");
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(attemptsBefore);
  });

  it("con RESEND_API_KEY real (fetch fake exitoso): marca 'sent' de verdad", async () => {
    const fixture = buildFixture();
    await seedReservationAndEnqueue(fixture);

    const fetchImpl = (async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })) as typeof fetch;
    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });

    expect(summary.notConfigured).toBe(false);
    expect(summary.sent).toBe(1);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "reservation.created");
    expect(job?.status).toBe("sent");
  });

  it("agota los reintentos reales y termina en 'dead' tras MAX_EMAIL_DISPATCH_ATTEMPTS (con proveedor configurado, Resend siempre en error)", async () => {
    const fixture = buildFixture();
    await seedReservationAndEnqueue(fixture);
    const fetchImpl = (async () => new Response("Resend caído", { status: 500 })) as typeof fetch;

    let lastSummary;
    for (let i = 0; i < MAX_EMAIL_DISPATCH_ATTEMPTS; i++) {
      lastSummary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    }
    expect(lastSummary!.dead).toBe(1);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "reservation.created");
    expect(job?.status).toBe("dead");

    // Un job 'dead' nunca se vuelve a reclamar en corridas futuras.
    const afterDead = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    expect(afterDead.processed).toBe(0);
  });

  it("nunca toca una fila channel='whatsapp' del mismo outbox", async () => {
    const fixture = buildFixture();
    await fixture.repo.enqueueMessagingOutbox(fixture.propertyId, fixture.organizationId, "whatsapp", "reservation.reminder", "reminder:some-id", { to: "5599998888", body: "recordatorio" });

    const fetchImpl = (async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })) as typeof fetch;
    const summary = await dispatchPendingEmailJobs(fixture.repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });
    expect(summary.processed).toBe(0);
    const whatsappJob = fixture.repo.getOutbox().find((o) => o.channel === "whatsapp");
    expect(whatsappJob?.status).toBe("pending"); // nunca tocado por el dispatcher de correo.
  });
});
