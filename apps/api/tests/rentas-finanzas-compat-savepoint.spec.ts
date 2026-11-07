// REGLA DURA de compatibilidad con la base SIN migrar (migracion 035) para el dinero de rentas: el request corre en UNA transaccion; con el
// PostgresRentasRepository REAL y una sesion que reproduce el estado ABORTADO de Postgres (25P02), el reintento sin la columna `origen` y el
// 503 del importador deben dejar la MISMA sesion utilizable (ROLLBACK TO SAVEPOINT) para la bitacora y el COMMIT del request.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PostgresRentasRepository } from "@atiende/domain-rentas";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { crearMovimientoDeReservaDirecta } from "../src/routes/verticals/rentas/reservas.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-rentas/tests/support/aborting-fake-session.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

const CSV = readFileSync(new URL("../../../packages/domain-rentas/tests/fixtures/pagos/airbnb-transacciones.csv", import.meta.url), "utf8");
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query/i, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("reserva directa con monto contra la base sin la migracion 035 (columna origen)", () => {
  const datos = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    propertyId: "00000000-0000-4000-8000-000000000002",
    ocupacionId: "00000000-0000-4000-8000-000000000003",
    canalId: "00000000-0000-4000-8000-000000000004",
    userId: "00000000-0000-4000-8000-000000000005",
    monto: { montoBrutoCentavos: 300000, moneda: "MXN" },
    pedido: { modo: "monto", montoBrutoCentavos: 300000, moneda: "MXN", comisionGestorBasisPoints: 1000, comisionGestorBase: "neto_de_canal" } as const,
  };
  const REGLA: FakeSessionHandler = { match: /from rentas\.regla_comision_canal/i, respond: () => [{ ya_neto_de_comision: true, comision_basis_points: 0, fuente: "Reserva directa" }] };
  const AUDITORIA: FakeSessionHandler = { match: /rentas\.record_audit_log/i, respond: () => [] };

  it("42703 en el INSERT con origen -> ROLLBACK TO SAVEPOINT, reintento sin la columna y bitacora sobre la MISMA transaccion sana", async () => {
    let conOrigen = 0;
    let sinOrigen = 0;
    const session = new AbortAwareFakeSession([
      REGLA,
      { match: /insert into rentas\.reserva_financiero[\s\S]*created_by, origen\)/i, respond: () => { conOrigen++; return pgError("42703", 'column "origen" of relation "reserva_financiero" does not exist'); } },
      { match: /insert into rentas\.reserva_financiero/i, respond: () => { sinOrigen++; return [{ id: "rf-1", created_at: "2026-11-10" }]; } },
      AUDITORIA,
      SIGUIENTE,
    ]);
    const repo = new PostgresRentasRepository(session);
    const movimiento = await crearMovimientoDeReservaDirecta(session, repo, datos);
    expect(movimiento).toMatchObject({ montoBrutoCentavos: 300000, comisionGestorCentavos: 30000, netoCentavos: 270000, origen: "directa_automatica" });
    expect(conOrigen).toBe(1);
    expect(sinOrigen).toBe(1);
    const i = session.calls.findIndex((c) => c.startsWith("rollback to savepoint"));
    expect(i).toBeGreaterThan(-1);
    // la bitacora corre DESPUES del rollback del reintento y la transaccion sigue utilizable para el COMMIT del request
    expect(session.calls.slice(i).some((c) => c.includes("record_audit_log") || c.startsWith("select rentas.record_audit_log"))).toBe(true);
    await expect(session.query("select 1 as siguiente_query")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("un error que NO es de migracion (RLS 42501) se propaga y no se reintenta", async () => {
    let intentos = 0;
    const session = new AbortAwareFakeSession([REGLA, { match: /insert into rentas\.reserva_financiero/i, respond: () => { intentos++; return pgError("42501", "new row violates row-level security policy"); } }]);
    await expect(crearMovimientoDeReservaDirecta(session, new PostgresRentasRepository(session), datos)).rejects.toMatchObject({ code: "42501" });
    expect(intentos).toBe(1);
  });
});

describe("POST /payouts/importar-csv (aplicar:true) contra la base sin la migracion 035", () => {
  it("42P01 -> 503 'no disponible aun' y la transaccion del request queda sana (ROLLBACK TO SAVEPOINT)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const canal = (await ctx.rentasRepo.findCanalPorCodigo("airbnb"))!;
    const fake = new AbortAwareFakeSession([
      { match: /from rentas\.canal/i, respond: () => [{ id: canal.id, codigo: "airbnb" }] },
      { match: /pg_advisory_xact_lock/i, respond: () => [] },
      { match: /from rentas\.(ocupacion|importacion_pagos_linea)/i, respond: () => pgError("42P01", 'relation "rentas.importacion_pagos_linea" does not exist') },
      SIGUIENTE,
    ]);
    // Las consultas de rentas.* y todo SAVEPOINT van a la sesion abortable; lo demas (membresia, auth) al motor en memoria.
    const real = ctx.engine;
    const engine: TenancyEngine = {
      withAppSession: (claims, fn) =>
        real.withAppSession(claims, (s) => {
          const hibrida: TenantDbSession = {
            query: (sql, params) => (/rentas\.|pg_advisory/i.test(sql) || /siguiente_query/.test(sql) ? fake.query(sql, params) : s.query(sql, params)),
            exec: (sql) => fake.exec(sql),
          };
          return fn(hibrida);
        }),
    };
    const app = buildApp({ ...ctx.deps, engine, rentasRepo: (db) => new PostgresRentasRepository(db) });
    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts/importar-csv`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", contenidoCsv: CSV, aplicar: true, comisionGestorBasisPoints: 1000, comisionGestorBase: "neto_de_canal" }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "rentas_finanzas_autopiloto_no_disponible" });
    expect(fake.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(fake.query("select 1 as siguiente_query")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});
