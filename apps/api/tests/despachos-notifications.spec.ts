// Hallazgo de auditoría (severidad ALTA): "despachos no tiene ninguna
// infraestructura de correo (ni outbox, ni plantilla HTML, ni dispatch)".
// Test de integración real (HTTP, sin mockear el motor de dominio) de las 2
// rutas internas nuevas: el barrido de recordatorios de cobranza
// (`GET/POST /internal/despachos/cobranza-reminders`) y el dispatcher de correo
// (`GET/POST /internal/despachos/email-dispatch`). Mismo patrón gateado por
// `internalOrCronSecretMatches` que `hoteles-email-dispatch.spec.ts`/
// `citas-email-dispatch.spec.ts` (leídos primero como plantilla) -- ambas rutas
// aceptan GET (única forma en que Vercel Cron las puede disparar, con
// `Authorization: Bearer <CRON_SECRET>`) además del POST manual con el header
// `x-atiende-internal-secret` que ya cubrían los tests originales.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";

describe("POST /internal/despachos/cobranza-reminders", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/cobranza-reminders", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, escanea la cartera pendiente y encola correo real al cliente con contacto capturado", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invoice = await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioFiscal: randomUUID(),
      tipo: "I",
      rfcEmisor: "CON950820K12",
      rfcReceptor: "XAXX010101000",
      emisorNombre: "PROVEEDOR",
      subtotal: 1000,
      total: 1160,
      iva: 160,
      descuento: 0,
      categoria: "sin_clasificar",
      valido: true,
      issues: [],
      warnings: [],
      requiresHumanReview: false,
      diot: { proveedoresReportables: [], reportable: false },
      fecha: "2026-08-01",
    });
    // Vence hoy -- coincide EXACTO con la etapa 'vencimiento' (offset 0), ver
    // cobranza/engine.ts::etapaRecordatorioCobranzaHoy.
    const todayIso = new Date().toISOString().slice(0, 10);
    await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: invoice.id, fechaVencimiento: todayIso, clienteNombre: "Cliente de Prueba", clienteEmail: "cliente@example.com" });

    const res = await app.request("/internal/despachos/cobranza-reminders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; organizations_checked: number; reminders_due: number; emails_enqueued: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.organizations_checked).toBe(1);
    expect(body.reminders_due).toBe(1);
    expect(body.emails_enqueued).toBe(1);
    expect(body.failures).toEqual([]);

    const outbox = ctx.despachosRepo.getMessagingOutbox();
    expect(outbox.some((j) => j.eventType === "cobranza.vencimiento" && j.payload.to === "cliente@example.com")).toBe(true);
  });

  // Cierre del hallazgo "despachos no tiene disparo inline de correo, solo el
  // cron diario -- un correo encolado puede tardar hasta ~24h en salir" (ver
  // ../src/routes/verticals/despachos/notifications.ts::triggerDespachosEmailDispatchInline).
  // Este barrido corre en un cron SEPARADO del de `/internal/despachos/email-dispatch`
  // (vercel.json los agenda por separado), así que el gap real que cierra esta
  // fase es que YA NO hace falta esperar a que corra el OTRO cron.
  it("el barrido dispara el envío inline del correo recién encolado, sin llamar aparte a /internal/despachos/email-dispatch", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const invoice = await ctx.despachosRepo.insertInvoice({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioFiscal: randomUUID(),
      tipo: "I",
      rfcEmisor: "CON950820K12",
      rfcReceptor: "XAXX010101000",
      emisorNombre: "PROVEEDOR",
      subtotal: 1000,
      total: 1160,
      iva: 160,
      descuento: 0,
      categoria: "sin_clasificar",
      valido: true,
      issues: [],
      warnings: [],
      requiresHumanReview: false,
      diot: { proveedoresReportables: [], reportable: false },
      fecha: "2026-08-01",
    });
    const todayIso = new Date().toISOString().slice(0, 10);
    await ctx.despachosRepo.registerReceivable({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: invoice.id, fechaVencimiento: todayIso, clienteNombre: "Cliente de Prueba", clienteEmail: "cliente@example.com" });

    const res = await app.request("/internal/despachos/cobranza-reminders", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);

    // Sin ningún POST/GET a /internal/despachos/email-dispatch de por medio: el
    // disparo inline ya reclamó el job y marcó el intento fallido (fail-closed,
    // sin RESEND_API_KEY en este fixture) DENTRO de esta misma corrida.
    const job = ctx.despachosRepo.getMessagingOutbox().find((j) => j.eventType === "cobranza.vencimiento");
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` -- nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/cobranza-reminders", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/cobranza-reminders", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/despachos/email-dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin RESEND_API_KEY configurada, un job pendiente se procesa y falla explícito (nunca 'sent')", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.despachosRepo.enqueueMessagingOutbox(ctx.organizationId, "email", "vencimiento.escalado", "dedupe-test-1", { to: "owner@despacho.mx", subject: "Asunto", html: "<p>hola</p>", text: "hola" });

    const res = await app.request("/internal/despachos/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);

    const job = ctx.despachosRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "vencimiento.escalado");
    expect(job?.status).toBe("failed");
  });

  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/despachos/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

// Cierre del hallazgo "despachos no tiene disparo inline de correo" -- prueba la
// propiedad real que le importa a la auditoría: el cron diario y el disparo
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
    const ctx = await buildDespachosTestContext(buildApp);
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { apiKey: "re_test_key", from: ctx.deps.env.resend.from } } };
    const app = buildApp(deps);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    ctx.despachosRepo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.admin.email, fullName: "admin" });
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2020, month: 1 }));
    const listado = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const [deadline] = (await listado.json()) as { id: string }[];

    const escalar = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/escalar`, authedJson(ctx.staff.contador.token, {}));
    expect(escalar.status).toBe(201);

    // El disparo inline, DENTRO del propio POST /escalar, ya mandó el correo real.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = ctx.despachosRepo.getMessagingOutbox().find((j) => j.eventType === "vencimiento.escalado");
    expect(job?.status).toBe("sent");

    // El cron diario (red de seguridad) corre después sobre la misma fila -- el
    // reclamo atómico nunca reclama una fila ya 'sent', así que no reenvía.
    const cronRes = await app.request("/internal/despachos/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(cronRes.status).toBe(200);
    const body = (await cronRes.json()) as { processed: number };
    expect(body.processed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // sigue en 1 -- nunca se reenvía.
  });
});
