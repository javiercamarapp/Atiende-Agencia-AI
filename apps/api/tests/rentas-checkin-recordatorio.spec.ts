// Fase 9 — GET/POST /internal/rentas/checkin-recordatorio: corrida periódica real
// del recordatorio de check-in (ver
// @atiende/domain-rentas::runRecordatorioCheckInCore). Hallazgo de auditoría: esta
// ruta solo aceptaba POST, así que Vercel Cron (que únicamente dispara GET) nunca la
// ejecutaba en producción -- mismo patrón/guard que rentas-ical-sync.spec.ts/
// citas-email-dispatch.spec.ts (leídos primero como plantilla).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

/** YYYY-MM-DD real, `offsetDias` días a partir de hoy (UTC) -- nunca una fecha
 * fija hardcoded (mismo criterio que citas-email-dispatch.spec.ts) para que la
 * reserva caiga dentro de la ventana 24-48h de `runRecordatorioCheckInCore`
 * sin importar cuándo corra el test. */
function fechaLocalEnDias(offsetDias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}

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

  // Cierre del hallazgo "rentas no tiene disparo inline de correo, solo el cron
  // diario -- un correo encolado puede tardar hasta ~24h en salir" (ver
  // ../src/routes/verticals/rentas/email-dispatch.ts::triggerRentasEmailDispatchInline).
  // Este barrido corre en un cron SEPARADO del de
  // `/internal/rentas/email-dispatch` (vercel.json los agenda por separado), así
  // que el gap real que cierra esta fase es que YA NO hace falta esperar a que
  // corra el OTRO cron.
  it("el barrido dispara el envío inline del correo de recordatorio, sin llamar aparte a /internal/rentas/email-dispatch", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Check-in mañana (24h): cae dentro de la ventana real de
    // runRecordatorioCheckInCore (ver packages/domain-rentas/src/checkin-reminders.ts).
    const checkIn = fechaLocalEnDias(1);
    const checkOut = fechaLocalEnDias(4);
    const crearRes = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`,
      authedJson(ctx.staff.adminGestora.token, { rango: { inicio: checkIn, fin: checkOut }, huespedNombre: "Ana Pérez", huespedContacto: "ana@example.com" }),
    );
    expect(crearRes.status).toBe(201);
    // El disparo inline de la propia creación de la reserva ("reserva.creada") ya
    // dejó ese job en 'failed' -- lo que importa aquí es el job DISTINTO que
    // encola este barrido ("reserva.recordatorio_checkin").
    expect(ctx.rentasRepo.getMessagingOutbox().filter((o) => o.eventType === "reserva.creada")).toHaveLength(1);

    const res = await app.request("/internal/rentas/checkin-recordatorio", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesadas: number; enviados: number };
    expect(body.procesadas).toBe(1);
    expect(body.enviados).toBe(1); // "enviados" = encolado con éxito, ver runRecordatorioCheckInCore.

    // Sin ningún POST/GET a /internal/rentas/email-dispatch de por medio: el
    // disparo inline ya reclamó el job y marcó el intento fallido (fail-closed,
    // sin RESEND_API_KEY en este fixture) DENTRO de esta misma corrida.
    const job = ctx.rentasRepo.getMessagingOutbox().find((o) => o.eventType === "reserva.recordatorio_checkin");
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
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
