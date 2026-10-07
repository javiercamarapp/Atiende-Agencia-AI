// H-P3-03 -- cron /internal/hoteles/holds-vencidos: libera las pre-reservas vencidas de TODA property activa aunque el agente no
// opere. Integracion HTTP real (app.request) + barrido directo con reloj inyectado, sobre el repositorio en memoria. La funcion SQL
// real (`booking_hold_expire_due`) y su guard de sistema los cubre scripts/verify-hoteles-reservas-agente contra Postgres real; el
// SAVEPOINT contra base sin migrar, packages/domain-hoteles/tests/reservas-agente/postgres-repository-savepoint.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReservasAgenteRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { runHoldsVencidosSweep } from "../src/routes/verticals/hoteles/holds-vencidos-cron.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";

const T0 = new Date("2031-06-01T18:00:00Z");
const PHONE = "+5219991110001";

async function setup(opts: { migrated?: boolean } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const reservas = new InMemoryReservasAgenteRepository();
  reservas.clock = () => T0;
  reservas.migrationApplied = opts.migrated !== false;
  const doble = randomUUID();
  reservas.seedProperty(ctx.propertyId, { organizationId: ctx.organizationId });
  reservas.seedRoomType(ctx.propertyId, doble, "Doble", 2);
  reservas.seedInventory(ctx.propertyId, doble, "2031-06-01", "2031-07-15", 2, 150_000);
  reservas.setPolicy(ctx.propertyId, { holdsEnabled: true, holdTtlMinutes: 60 });
  const deps = { ...ctx.deps, hotelesReservasAgenteRepo: () => reservas };
  const app = buildApp(deps);
  const crearHold = () =>
    reservas.createHold({
      propertyId: ctx.propertyId,
      roomTypeId: doble,
      checkInDate: "2031-06-12",
      checkOutDate: "2031-06-14",
      guests: 2,
      guestName: "Ana Torres",
      contactPhone: PHONE,
      channel: "whatsapp",
      idempotencyKey: randomUUID(),
      expectedTotalCents: 357_000,
      now: T0,
    });
  const cron = (method = "POST") => app.request("/internal/hoteles/holds-vencidos", { method, headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  return { ctx, reservas, deps, app, doble, crearHold, cron };
}

const enMinutos = (m: number) => new Date(T0.getTime() + m * 60_000);

describe("cron de holds vencidos (/internal/hoteles/holds-vencidos)", () => {
  it("sin secreto: 401, y no libera nada", async () => {
    const s = await setup();
    await s.crearHold();
    expect((await s.app.request("/internal/hoteles/holds-vencidos", { method: "POST" })).status).toBe(401);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(1);
  });

  it("libera el inventario de un hold vencido aunque el agente no vuelva a operar, y una segunda corrida es idempotente", async () => {
    const s = await setup();
    const hold = await s.crearHold();
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(1);

    const results = await runHoldsVencidosSweep(s.deps, enMinutos(61));
    const mine = results.find((r) => r.propertyId === s.ctx.propertyId)!;
    expect(mine).toMatchObject({ vencidos: 1, omitida: null, error: null });
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(0);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-13")).toBe(0);
    expect(s.reservas.allHolds().find((h) => h.id === hold.id)!.status).toBe("expirado");

    const again = (await runHoldsVencidosSweep(s.deps, enMinutos(120))).find((r) => r.propertyId === s.ctx.propertyId)!;
    expect(again.vencidos).toBe(0);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(0);
  });

  it("un hold que aun no vence NO se toca", async () => {
    const s = await setup();
    const hold = await s.crearHold();
    const mine = (await runHoldsVencidosSweep(s.deps, enMinutos(30))).find((r) => r.propertyId === s.ctx.propertyId)!;
    expect(mine.vencidos).toBe(0);
    expect(s.reservas.booked(s.ctx.propertyId, s.doble, "2031-06-12")).toBe(1);
    expect(s.reservas.allHolds().find((h) => h.id === hold.id)!.status).not.toBe("expirado");
  });

  it("la ruta HTTP responde el resumen y acepta GET y POST con el secreto interno", async () => {
    const s = await setup();
    await s.crearHold();
    // Reloj real (2026) <= vencimiento (2031): la ruta no vence nada, pero responde el contrato.
    for (const method of ["POST", "GET"]) {
      const res = await s.cron(method);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, vencidos_total: 0, corridas: [{ omitida: null, vencidos: 0, error: null }] });
    }
  });

  it("base sin la migracion 037: la property se omite (migracion_pendiente) sin fallar el latido", async () => {
    const s = await setup({ migrated: false });
    const res = await s.cron();
    const body = (await res.json()) as { ok: boolean; corridas: { omitida: string | null }[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.corridas.every((c) => c.omitida === "migracion_pendiente")).toBe(true);
  });

  it("un fallo real de una property se reporta (ok:false) en vez de esconderse", async () => {
    const s = await setup();
    s.reservas.expireDueHolds = async () => {
      throw new Error("boom");
    };
    const results = await runHoldsVencidosSweep(s.deps, enMinutos(61));
    expect(results.some((r) => r.error === "boom")).toBe(true);
    const res = await s.cron();
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });
});
