// QA-citas-R1-automatizacion-10: el dedupe "una vez por dia" de los avisos del cron de citas usa el dia LOCAL del negocio (Merida, UTC-6), no el dia UTC.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildCitasTestContext, type CitasTestContext } from "./citas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function seedPendiente(ctx: CitasTestContext, horas: number): Promise<void> {
  const customer = await ctx.citasRepo.upsertCustomer(ctx.organizationId, `99800${Math.floor(Math.random() * 1e6)}`, "Cliente", null);
  const startsAt = new Date(Date.now() + horas * 3_600_000).toISOString();
  ctx.citasRepo.seedAppointment({
    id: randomUUID(), organizationId: ctx.organizationId, propertyId: null, providerId: ctx.providerId, serviceId: ctx.serviceId, customerId: customer.id,
    startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(), status: "pending", source: "web", notes: null, dedupeFingerprint: null, idempotencyKey: null,
    reminder24hSentAt: null, createdAt: new Date().toISOString(), googleEventId: null, googleSyncStatus: "skipped", googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null,
  });
}

afterEach(() => vi.useRealTimers());

describe("QA-citas-R1-automatizacion-10: dedupe diario de avisos por dia LOCAL del negocio", () => {
  it("'citas por confirmar' se avisa una vez por dia de Merida, no dos (08:00 y 18:30 del mismo dia local)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T14:00:00.000Z")); // 08:00 Merida
    const ctx = await buildCitasTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    await seedPendiente(ctx, 30);
    const cron = () => buildApp(deps).request("/internal/citas/confirmacion-cita", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    await cron();
    vi.setSystemTime(new Date("2026-10-22T00:30:00.000Z")); // 18:30 Merida del MISMO 21 de octubre
    await cron();
    const claves = new Set(emisiones.filter((e) => e.evento === "citas.cita.por_confirmar" && e.organizationId === ctx.organizationId).map((e) => e.dedupeKey));
    expect(claves.size).toBe(1);
    expect([...claves][0]).toContain("2026-10-21");
    // al dia local siguiente (08:00 Merida del 22) si vuelve a avisar
    vi.setSystemTime(new Date("2026-10-22T14:00:00.000Z"));
    await seedPendiente(ctx, 30);
    await cron();
    const claves2 = new Set(emisiones.filter((e) => e.evento === "citas.cita.por_confirmar" && e.organizationId === ctx.organizationId).map((e) => e.dedupeKey));
    expect(claves2.size).toBe(2);
  });
});
