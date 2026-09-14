// Fase 6 §3 — POST /internal/citas/email-dispatch: fail-closed real sin
// RESEND_API_KEY, y guard de secreto interno (mismo patrón que
// citas-google-calendar.spec.ts para el cron de sincronización).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

/** Próximo lunes real (UTC), a las 10:00 hora de Ciudad de México (UTC-6 fijo,
 * sin horario de verano) -- un slot real dentro del horario lunes-viernes
 * 9:00-17:00 que buildCitasTestContext siembra. */
function nextMondayAt10amMexicoCityIso(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diff = ((1 - date.getUTCDay() + 7) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + diff);
  date.setUTCHours(16, 0, 0, 0); // 10:00 local == 16:00 UTC.
  return date.toISOString();
}

describe("POST /internal/citas/email-dispatch", () => {
  it("sin el secreto interno responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/email-dispatch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("fail-closed: sin RESEND_API_KEY configurada, un job pendiente se procesa y falla explícito (nunca 'sent')", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Crea la cita vía el endpoint HTTP real (source=web) — es ese endpoint quien
    // encola el correo real (tryEnqueueAppointmentEmail), no el dominio puro.
    const createRes = await app.request("/v1/citas/clinica-dental-sonrisas/appointments", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        provider_id: ctx.providerId,
        service_id: ctx.serviceId,
        customer_name: "Cliente Correo",
        customer_phone: "9991112222",
        customer_email: "cliente@example.com",
        starts_at: nextMondayAt10amMexicoCityIso(),
      }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("/internal/citas/email-dispatch", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; sent: number; failed: number };
    expect(body.processed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);

    const job = ctx.citasRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "appointment.created");
    expect(job?.status).toBe("failed");
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/email-dispatch", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/email-dispatch", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/email-dispatch", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});
