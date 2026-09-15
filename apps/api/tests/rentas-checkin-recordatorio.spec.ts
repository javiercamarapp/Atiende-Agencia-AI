// Fase 9 — GET/POST /internal/rentas/checkin-recordatorio: corrida periódica real
// del recordatorio de check-in (ver
// @atiende/domain-rentas::runRecordatorioCheckInCore). Hallazgo de auditoría: esta
// ruta solo aceptaba POST, así que Vercel Cron (que únicamente dispara GET) nunca la
// ejecutaba en producción -- mismo patrón/guard que rentas-ical-sync.spec.ts/
// citas-email-dispatch.spec.ts (leídos primero como plantilla).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildRentasTestContext } from "./rentas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

describe("GET/POST /internal/rentas/checkin-recordatorio", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, corre el barrido (sin reservas próximas a check-in, procesa 0)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesadas: number; enviados: number; sin_correo: number; fallos: number };
    expect(body).toEqual({ ok: true, procesadas: 0, enviados: 0, sin_correo: 0, fallos: 0 });
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` -- nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET con un Bearer incorrecto responde 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "GET", headers: { authorization: "Bearer secreto-equivocado" } });
    expect(res.status).toBe(401);
  });
});
