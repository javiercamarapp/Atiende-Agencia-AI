// Fase 10 — test de integración real (HTTP, sin mockear el motor de dominio)
// de las 2 rutas internas nuevas: el barrido combinado de alertas
// (`POST /internal/licitaciones/alert-notifications`) y el dispatcher de
// correo (`POST /internal/licitaciones/email-dispatch`). Mismo patrón
// gateado por `x-atiende-internal-secret` que
// `apps/api/tests/licitaciones-discover.spec.ts`/`citas-email-dispatch.spec.ts`
// (leídos primero como plantilla).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

describe("POST /internal/licitaciones/alert-notifications", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/alert-notifications", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, escanea las 3 fuentes de alerta y encola correo real al responsable de la organización", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const app = buildApp(ctx.deps);

    // buildLicitacionesTestContext ya siembra el staff owner/admin real vía
    // coreRepo.addMembership -- pero `InMemoryLicitacionesRepository` (el repo del
    // DOMINIO, un objeto distinto de coreRepo, ver comentario de cabecera de
    // licitaciones-fixtures.ts) necesita su PROPIO seed de destinatarios (mismo
    // criterio que `repo.seedOrganization` duplica lo que coreRepo.addOrganization ya
    // tiene, para que `findOrganizationBySlug` funcione sin acoplar los dos repos).
    ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.owner.email, fullName: "Owner" });

    // Convocatoria con vencimiento próximo -- relativo a "ahora" (nunca una fecha
    // fija hardcoded, mismo criterio que licitaciones-discover.spec.ts para que el
    // test no envejezca): la ruta usa `runAlertNotificationSweep(repo)` SIN
    // `now`/`todayIsoDate` inyectado (misma firma real que un scheduler externo
    // invocaría en producción), así que la ventana de anticipación se evalúa contra
    // el reloj real del proceso.
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const res = await app.request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; organizations_checked: number; emails_enqueued: number; deadline_reminders_created: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.organizations_checked).toBe(1);
    expect(body.deadline_reminders_created).toBe(1);
    expect(body.emails_enqueued).toBeGreaterThanOrEqual(1);
    expect(body.failures).toEqual([]);

    const outbox = ctx.repo.getMessagingOutbox();
    expect(outbox.some((j) => j.eventType === "tender.deadline_reminder" && j.payload.to === ctx.staff.owner.email)).toBe(true);
  });
});

describe("POST /internal/licitaciones/email-dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin RESEND_API_KEY configurada, un job pendiente se procesa y falla explícito (nunca 'sent')", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.repo.enqueueMessagingOutbox(ctx.organizationId, "email", "tender.deadline_reminder", "dedupe-test-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);

    const job = ctx.repo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("failed");
  });
});

// Fase 12 (cierre del hallazgo ALTA "sin cron configurado") — `vercel.json` ya
// declara `crons` reales para estas 2 rutas. Vercel Cron dispara SIEMPRE con GET
// y solo puede mandar el secreto vía `Authorization: Bearer $CRON_SECRET` (no
// permite headers custom en su config) — estos tests cubren esa forma nueva de
// invocación sin tocar la existente (POST + header custom) de arriba.
describe("GET /internal/licitaciones/alert-notifications (invocación real de Vercel Cron)", () => {
  it("rechaza sin ningún secreto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/alert-notifications", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("con Authorization: Bearer <INTERNAL_SECRET> (lo que Vercel Cron manda automáticamente cuando CRON_SECRET está alineado), barre y encola igual que el POST manual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const app = buildApp(ctx.deps);
    ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.owner.email, fullName: "Owner" });
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto (cron)", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const res = await app.request("/internal/licitaciones/alert-notifications", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; emails_enqueued: number };
    expect(body.ok).toBe(true);
    expect(body.emails_enqueued).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /internal/licitaciones/email-dispatch (invocación real de Vercel Cron)", () => {
  it("rechaza sin ningún secreto", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("con Authorization: Bearer <INTERNAL_SECRET>, drena el outbox igual que el POST manual", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.repo.enqueueMessagingOutbox(ctx.organizationId, "email", "tender.deadline_reminder", "dedupe-test-cron-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.failed).toBe(1);
  });
});
