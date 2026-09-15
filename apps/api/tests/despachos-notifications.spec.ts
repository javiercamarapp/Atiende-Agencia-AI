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
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";

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
