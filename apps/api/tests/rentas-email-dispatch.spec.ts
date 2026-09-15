// Fase 9 — GET/POST /internal/rentas/email-dispatch: drena el canal `email` de
// `rentas.messaging_outbox` vía Resend. Mismo patrón/guard que
// citas-email-dispatch.spec.ts/hoteles-email-dispatch.spec.ts (leídos primero como
// plantilla) -- hallazgo de auditoría: esta ruta solo aceptaba POST, así que Vercel
// Cron (que únicamente dispara GET) nunca la ejecutaba en producción.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildRentasTestContext } from "./rentas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

describe("GET/POST /internal/rentas/email-dispatch", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin RESEND_API_KEY configurada, un job pendiente se procesa y falla explícito (nunca 'sent')", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await ctx.rentasRepo.enqueueMessagingOutbox(ctx.propertyId, ctx.organizationId, "email", "reserva.recordatorio_checkin", "dedupe-test-1", {
      to: "huesped@example.com",
      subject: "Asunto",
      html: "<p>hola</p>",
      text: "hola",
    });

    const res = await app.request("/internal/rentas/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);

    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "reserva.recordatorio_checkin");
    expect(job?.status).toBe("failed");
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` -- nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/email-dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});
