// Fase 10 — test de integración real (HTTP, sin mockear el motor de dominio)
// de las 2 rutas internas nuevas: el barrido combinado de alertas
// (`POST /internal/licitaciones/alert-notifications`) y el dispatcher de
// correo (`POST /internal/licitaciones/email-dispatch`). Mismo patrón
// gateado por `x-atiende-internal-secret` que
// `apps/api/tests/licitaciones-discover.spec.ts`/`citas-email-dispatch.spec.ts`
// (leídos primero como plantilla).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Cierre del hallazgo "licitaciones no tiene disparo inline de correo, solo el
  // cron diario -- un correo encolado puede tardar hasta ~24h en salir" (ver
  // ../src/routes/verticals/licitaciones/alertNotifications.ts::triggerLicitacionesEmailDispatchInline).
  // Este barrido corre en un cron SEPARADO del de
  // `/internal/licitaciones/email-dispatch` (vercel.json los agenda por
  // separado), así que el gap real que cierra esta fase es que YA NO hace falta
  // esperar a que corra el OTRO cron.
  it("el barrido dispara el envío inline del correo recién encolado, sin llamar aparte a /internal/licitaciones/email-dispatch", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const app = buildApp(ctx.deps);
    ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.owner.email, fullName: "Owner" });
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const res = await app.request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);

    // Fix a2b (CRÍTICO, seguimiento PR #166): sin RESEND_API_KEY en este
    // fixture, el disparo inline (`triggerLicitacionesEmailDispatchInline`) YA
    // NO reclama nada -- `dispatchPendingEmailJobs` corta antes del claim. El
    // job queda intacto en 'pending' (antes de este fix, quedaba 'failed' con
    // attempts=1 sin que Resend jamás lo hubiera visto).
    const job = ctx.repo.getMessagingOutbox().find((j) => j.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });
});

describe("POST /internal/licitaciones/email-dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fix a2b: sin RESEND_API_KEY configurada, responde 'not_configured' y NO reclama nada (cero intentos quemados)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.repo.enqueueMessagingOutbox(ctx.organizationId, "email", "tender.deadline_reminder", "dedupe-test-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; processed: number; sent: number; failed: number };
    expect(body.status).toBe("not_configured");
    expect(body.processed).toBe(0);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);

    const job = ctx.repo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("pending");
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

  it("con Authorization: Bearer <INTERNAL_SECRET>, responde 'not_configured' igual que el POST manual (sin proveedor, cero intentos quemados)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.repo.enqueueMessagingOutbox(ctx.organizationId, "email", "tender.deadline_reminder", "dedupe-test-cron-1", { to: "owner@empresa.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const res = await app.request("/internal/licitaciones/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; processed: number; failed: number };
    expect(body.status).toBe("not_configured");
    expect(body.processed).toBe(0);
    expect(body.failed).toBe(0);
  });
});

// Cierre del hallazgo "licitaciones no tiene disparo inline de correo" -- prueba
// la propiedad real que le importa a la auditoría: el cron diario y el disparo
// inline operan sobre la MISMA fila del outbox (reclamo atómico,
// `claim_email_outbox_batch`), así que un correo real nunca sale dos veces.
// Mismo criterio que licitaciones-discover.spec.ts para stubear SOLO el
// transporte HTTP (nunca la lógica de negocio): `vi.stubGlobal("fetch", ...)`
// sustituye la llamada real a la API de Resend.
describe("Disparo inline + cron: la misma fila nunca se envía dos veces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("con RESEND_API_KEY real, el correo se manda UNA sola vez aunque el cron corra después del disparo inline", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { submissionDeadline: null });
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { apiKey: "re_test_key", from: ctx.deps.env.resend.from } } };
    const app = buildApp(deps);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    ctx.repo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.owner.email, fullName: "Owner" });
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    ctx.repo.seedTender({ id: randomUUID(), organizationId: ctx.organizationId, title: "Vence pronto", submissionDeadline: soon, updatedAt: new Date().toISOString() });

    const sweepRes = await app.request("/internal/licitaciones/alert-notifications", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(sweepRes.status).toBe(200);

    // El disparo inline, DENTRO del propio POST del barrido, ya mandó el correo real.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = ctx.repo.getMessagingOutbox().find((j) => j.eventType === "tender.deadline_reminder");
    expect(job?.status).toBe("sent");

    // El cron diario (red de seguridad) corre después sobre la misma fila -- el
    // reclamo atómico nunca reclama una fila ya 'sent', así que no reenvía.
    const cronRes = await app.request("/internal/licitaciones/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(cronRes.status).toBe(200);
    const body = (await cronRes.json()) as { processed: number };
    expect(body.processed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // sigue en 1 -- nunca se reenvía.
  });
});
