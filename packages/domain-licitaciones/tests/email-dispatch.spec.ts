// Pruebas del motor de envío real (fail-closed) de correo — DUPLICADO
// deliberado de @atiende/domain-citas::tests/email-dispatch.spec.ts (leído
// primero como plantilla), sobre `InMemoryLicitacionesRepository` en vez de
// `InMemoryCitasRepository`. `sendEmailOutboxJob` recibe `fetchImpl`
// inyectado (nunca toca la red real, nunca un mock global).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { dispatchPendingEmailJobs, MAX_EMAIL_DISPATCH_ATTEMPTS, sendEmailOutboxJob } from "../src/email-dispatch.ts";
import type { EmailOutboxJobRow } from "../src/repository.ts";

function fakeJob(overrides: Partial<EmailOutboxJobRow> = {}): EmailOutboxJobRow {
  return { id: "job-1", organizationId: "org-1", attempts: 1, payload: { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" }, ...overrides };
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
    expect(body.to).toBe("owner@empresa.mx");
    expect(body.subject).toBe("Asunto");
    expect(body.html).toBe("<p>hola</p>");
  });

  it("Resend respondiendo error HTTP lanza con el detalle real (nunca finge éxito)", async () => {
    const fetchImpl = (async () => new Response("API key inválida", { status: 401 })) as typeof fetch;
    await expect(sendEmailOutboxJob(fetchImpl, fakeJob(), { apiKey: "re_bad_key", from: "a@b.com" })).rejects.toThrow(/401/);
  });
});

describe("dispatchPendingEmailJobs", () => {
  it("sin RESEND_API_KEY: reclama el lote, cada job falla explícito, se marca 'failed' (reintentable) — NUNCA 'sent'", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const organizationId = randomUUID();
    await repo.enqueueMessagingOutbox(organizationId, "email", "tender.deadline_reminder", "dedupe-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const summary = await dispatchPendingEmailJobs(repo, { apiKey: null, from: "a@b.com" });

    expect(summary.processed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.dead).toBe(0);
    const job = repo.getMessagingOutbox().find((o) => o.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("failed");
  });

  it("con RESEND_API_KEY real (fetch fake exitoso): marca 'sent' de verdad", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const organizationId = randomUUID();
    await repo.enqueueMessagingOutbox(organizationId, "email", "tender.deadline_reminder", "dedupe-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const fetchImpl = (async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 })) as typeof fetch;
    const summary = await dispatchPendingEmailJobs(repo, { apiKey: "re_test_key", from: "a@b.com" }, { fetchImpl });

    expect(summary.sent).toBe(1);
    const job = repo.getMessagingOutbox().find((o) => o.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("sent");
  });

  it("agota los reintentos reales y termina en 'dead' tras MAX_EMAIL_DISPATCH_ATTEMPTS", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const organizationId = randomUUID();
    await repo.enqueueMessagingOutbox(organizationId, "email", "tender.deadline_reminder", "dedupe-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    let lastSummary;
    for (let i = 0; i < MAX_EMAIL_DISPATCH_ATTEMPTS; i++) {
      lastSummary = await dispatchPendingEmailJobs(repo, { apiKey: null, from: "a@b.com" });
    }
    expect(lastSummary!.dead).toBe(1);
    const job = repo.getMessagingOutbox().find((o) => o.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("dead");

    // Un job 'dead' nunca se vuelve a reclamar en corridas futuras.
    const afterDead = await dispatchPendingEmailJobs(repo, { apiKey: null, from: "a@b.com" });
    expect(afterDead.processed).toBe(0);
  });
});
