// C-05 -- GET /v1/citas/properties/:propertyId/resumen sobre la app Hono real (InMemoryCitasRepository).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext } from "./citas-fixtures.ts";

interface ResumenBody {
  timezone: string;
  generated_at: string;
  today: { date: string; total: number; by_status: Record<string, number> };
  week: { from_date: string; to_date: string; total: number; by_status: Record<string, number> };
  pending_to_confirm: number;
  no_shows_last_30_days: number;
  new_customers_last_30_days: number;
  created_by_source_last_30_days: Record<string, number>;
}

describe("GET /v1/citas/properties/:propertyId/resumen", () => {
  it("un staff con membership ve los conteos de su organización, en snake_case, con la zona del negocio", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const now = new Date();
    ctx.citasRepo.seedAppointment({
      id: randomUUID(),
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      providerId: ctx.providerId,
      serviceId: ctx.serviceId,
      customerId: randomUUID(),
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      status: "pending",
      source: "web",
      notes: null,
      dedupeFingerprint: null,
      idempotencyKey: null,
      reminder24hSentAt: null,
      createdAt: now.toISOString(),
      googleEventId: null,
      googleSyncStatus: "skipped",
      googleSyncAttempts: 0,
      googleSyncNextRetryAt: null,
      googleSyncError: null,
    });

    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/resumen`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ResumenBody;
    expect(body.timezone).toBe("America/Merida");
    expect(body.today.total).toBe(1);
    expect(body.today.by_status.pending).toBe(1);
    expect(body.week.total).toBe(1);
    expect(body.week.from_date <= body.today.date && body.today.date <= body.week.to_date).toBe(true);
    expect(body.no_shows_last_30_days).toBe(0);
    expect(typeof body.pending_to_confirm).toBe("number");
    expect(typeof body.new_customers_last_30_days).toBe("number");
    // La cita sembrada es del canal web y se creó hoy: el resto de canales viene en 0 (todos presentes).
    expect(body.created_by_source_last_30_days).toEqual({ voice: 0, whatsapp: 0, web: 1, manual: 0 });
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${ctx.propertyId}/resumen`);
    expect(res.status).toBe(401);
  });

  it("una sucursal ajena (sin membership) no responde 200", async () => {
    const ctx = await buildCitasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/citas/properties/${randomUUID()}/resumen`, { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect([403, 404]).toContain(res.status);
  });
});
