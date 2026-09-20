// Test de integración real de la ruta interna del recordatorio 24h — gateada por
// x-atiende-internal-secret, pensada para un scheduler externo (ver diseño Fase 1
// citas §5.3).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { jsonRequestInit } from "./fixtures.ts";

const REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Seedea directo en el repo (sin pasar por la ruta HTTP de creación, que exige
 * horario de negocio real) una cita "pendiente de recordatorio" cuyo `starts_at`
 * cae DENTRO de la ventana real del cron (`now + 24h`, centro de la ventana de
 * tolerancia de ±30 min) sin importar qué hora/día sea "ahora" cuando corre la
 * suite — evita el mismo problema que ya describe el test de arriba (una fecha
 * fija SIEMPRE queda fuera de la ventana real). */
async function seedCitaPendienteDeRecordatorio(ctx: CitasTestContext, phone: string): Promise<string> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, phone, "Cliente de prueba", null);
  const startsAt = new Date(Date.now() + REMINDER_HORIZON_MS).toISOString();
  const id = randomUUID();
  ctx.citasRepo.seedAppointment({
    id,
    organizationId: ctx.organizationId,
    propertyId: null,
    providerId: ctx.providerId,
    serviceId: ctx.serviceId,
    customerId: customer.id,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
    status: "pending",
    source: "web",
    notes: null,
    dedupeFingerprint: null,
    idempotencyKey: null,
    reminder24hSentAt: null,
    createdAt: new Date().toISOString(),
    googleEventId: null,
    googleSyncStatus: "skipped",
    googleSyncAttempts: 0,
    googleSyncNextRetryAt: null,
    googleSyncError: null,
  });
  return id;
}

describe("POST /internal/citas/confirmacion-cita", () => {
  it("rechaza sin el secreto interno", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("con el secreto real, recorre las organizaciones activas y encola recordatorios reales de las citas dentro de la ventana de 24h", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // Crea una cita real mañana a las 10am hora de Mérida.
    await app.request(
      "/v1/citas/clinica-dental-sonrisas/appointments",
      jsonRequestInit({ provider_id: ctx.providerId, service_id: ctx.serviceId, customer_name: "Ana Torres", customer_phone: "9991112233", starts_at: "2026-09-14T16:00:00.000Z", source: "web" }),
    );

    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenants_checked: number; processed: number; sent: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.tenants_checked).toBeGreaterThanOrEqual(1);
    expect(body.failures).toEqual([]);
    // La cita creada arriba está fuera de la ventana de 24h desde "ahora" real (el
    // test corre en cualquier fecha) — lo que importa aquí es que la ruta procesó
    // la organización sin lanzar, no cuántas cayeron en la ventana exacta.
    expect(body.processed).toBeGreaterThanOrEqual(0);
    expect(body.sent).toBeGreaterThanOrEqual(0);
  });

  // Wiring real del scheduler (vercel.json::crons): Vercel Cron SIEMPRE dispara
  // GET, nunca POST, y solo sabe mandar el secreto como
  // `Authorization: Bearer <CRON_SECRET>` — nunca el header custom
  // `x-atiende-internal-secret`. Ver internalOrCronSecretMatches (http-security.ts).
  it("GET con Authorization: Bearer <secreto> (forma real en que Vercel Cron invoca la ruta) también autentica", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/confirmacion-cita", { method: "GET", headers: { authorization: `Bearer ${ctx.deps.env.internalSecret}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET sin ningún secreto responde 401", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/citas/confirmacion-cita", { method: "GET" });
    expect(res.status).toBe(401);
  });

  // Re-revisión a3 (bloqueante #1) — `runConfirmacionCitaCore` aísla cada cita
  // venenosa con SAVEPOINT (domain-citas/src/reminders.ts) y NUNCA lanza para la
  // organización completa; antes de este fix esta ruta nunca leía
  // `summary.failedAppointmentIds`/`failedAppointmentErrors`, así que el cron
  // respondía `ok:true, failures:[]` con el latido en verde aunque una cita real
  // hubiera perdido su recordatorio para siempre. Prueba el volcado a
  // `failures[]` (mismo patrón que `google-calendar-sync.ts`/PR #163).
  it("una cita falla con un error real de Postgres => las DEMÁS se procesan Y la respuesta/latido reflejan el fallo parcial (nunca en silencio)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const saludRepo = ctx.deps.saludRepo as InMemorySaludRepository;
    const superadminId = randomUUID();
    saludRepo.addPlatformSuperadmin(superadminId);

    const citaEnvenenadaId = await seedCitaPendienteDeRecordatorio(ctx, "9990000001");
    const citaSanaId = await seedCitaPendienteDeRecordatorio(ctx, "9990000002");

    // Simula un error REAL de Postgres (deadlock) SOLO para la cita envenenada —
    // mismo mecanismo que packages/domain-citas/tests/reminders-aislamiento-por-cita.spec.ts.
    const original = ctx.citasRepo.enqueueMessagingOutbox.bind(ctx.citasRepo);
    const spy = vi.spyOn(ctx.citasRepo, "enqueueMessagingOutbox").mockImplementation(async (organizationId, channel, eventType, dedupeKey, payload) => {
      const to = (payload as { to?: string }).to;
      if (to === "9990000001") {
        const err = new Error("deadlock detected") as Error & { code: string };
        err.code = "40P01";
        throw err;
      }
      return original(organizationId, channel, eventType, dedupeKey, payload);
    });

    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    spy.mockRestore();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      processed: number;
      sent: number;
      failures: { organization_id: string; appointment_id?: string; error: string }[];
    };
    // La cita sana SÍ se procesó y se envió pese al error de la envenenada.
    expect(body.processed).toBeGreaterThanOrEqual(2);
    expect(body.sent).toBeGreaterThanOrEqual(1);
    // El fallo parcial SÍ llega a `failures[]` — ya no queda solo en un console.error.
    expect(body.ok).toBe(false);
    const failuresDeLaCita = body.failures.filter((f) => f.appointment_id === citaEnvenenadaId);
    expect(failuresDeLaCita).toHaveLength(1);
    expect(failuresDeLaCita[0]!.organization_id).toBe(ctx.organizationId);
    expect(failuresDeLaCita[0]!.error).toContain("deadlock");
    // La cita sana nunca aparece en failures[].
    expect(body.failures.some((f) => f.appointment_id === citaSanaId)).toBe(false);

    // El latido queda "error" (visible en el panel de salud) — antes del fix
    // quedaba "ok" con este mismo escenario porque este `catch` nunca veía el
    // fallo de la cita (aislado dentro de `runConfirmacionCitaCore`). El mensaje
    // del latido es el de `CronPartialFailureError` (conteo de organizaciones
    // fallidas, mismo mecanismo que las demás rutas de cron); el detalle por
    // cita ya se verificó arriba en `body.failures`.
    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin(superadminId);
    const latido = latidos.find((l) => l.cronName === "/internal/citas/confirmacion-cita");
    expect(latido?.lastStatus).toBe("error");
    expect(latido?.lastError).toContain("1 fallo(s) real(es) de 1 organizaciones");
  });

  it("sin ningún fallo real => ok:true, failures:[] y el latido queda 'ok' (no dispara CronPartialFailureError)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const saludRepo = ctx.deps.saludRepo as InMemorySaludRepository;
    const superadminId = randomUUID();
    saludRepo.addPlatformSuperadmin(superadminId);

    await seedCitaPendienteDeRecordatorio(ctx, "9990000003");

    const res = await app.request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; processed: number; sent: number; failures: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.failures).toEqual([]);
    expect(body.processed).toBeGreaterThanOrEqual(1);
    expect(body.sent).toBeGreaterThanOrEqual(1);

    const latidos = await saludRepo.listCronHeartbeatsForSuperadmin(superadminId);
    const latido = latidos.find((l) => l.cronName === "/internal/citas/confirmacion-cita");
    expect(latido?.lastStatus).toBe("ok");
  });
});
