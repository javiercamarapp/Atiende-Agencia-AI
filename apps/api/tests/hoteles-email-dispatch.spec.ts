// Fase 12 hoteles (hallazgo ALTA) — POST/GET /internal/hoteles/email-dispatch:
// fail-closed real sin RESEND_API_KEY, y guard de secreto interno. Mismo patrón
// que apps/api/tests/citas-email-dispatch.spec.ts.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

describe("POST /internal/hoteles/email-dispatch", () => {
  it("sin el secreto interno responde 401", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fix a2b: sin RESEND_API_KEY configurada, responde 'not_configured' y NO reclama nada (cero intentos quemados)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Crea la reserva vía el endpoint HTTP real, con un huésped real (con correo en
    // archivo) — es ese endpoint quien encola el correo real (tryEnqueueGuestEmail),
    // no el dominio puro.
    const createRes = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03", guestId: ctx.guestId }, { "idempotency-key": "k-email-dispatch-1" }),
    );
    expect(createRes.status).toBe(201);

    const res = await app.request("/internal/hoteles/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; processed: number; sent: number; failed: number };
    // Fix a2b (CRÍTICO, seguimiento PR #166): sin proveedor configurado, la
    // ruta responde 200 con `status: "not_configured"` y NUNCA reclama el
    // outbox (cross-tenant, cuenta intento) -- antes de este fix,
    // `processed`/`failed` eran 1 aquí, quemando un intento del job por cada
    // invocación de este cron (o del drenado post-commit de cada acción de
    // staff) sin que Resend jamás lo hubiera visto.
    expect(body.status).toBe("not_configured");
    expect(body.processed).toBe(0);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);

    const job = ctx.hotelesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "reservation.created");
    expect(job?.status).toBe("pending");
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/email-dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});
