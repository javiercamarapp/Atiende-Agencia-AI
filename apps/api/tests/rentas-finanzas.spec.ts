// Test de integración end-to-end del flujo 3 (movimiento financiero de una reserva,
// regla Finanzas-1, ver diseño Fase 1 rentas §4, Flujo 3) — HTTP real.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

async function crearReservaDirecta(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof buildRentasTestContext>>): Promise<string> {
  const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-05" } }));
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe("POST /rentas/:propertyId/reservas/:ocupacionId/movimiento", () => {
  it("calcula y persiste el movimiento -- reserva directa (comisión de canal 0%, sembrada en la fixture)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
      authedJson(ctx.staff.adminGestora.token, {
        moneda: "MXN",
        montoBrutoCentavos: 600000,
        comisionGestorBasisPoints: 2000,
        comisionGestorBase: "neto_de_canal",
        gastos: [{ tipo: "limpieza", montoCentavos: 30000 }],
        impuestos: [],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { comisionCanalCentavos: number; comisionGestorCentavos: number; netoCentavos: number };
    expect(body.comisionCanalCentavos).toBe(0); // reserva directa, sin canal
    expect(body.comisionGestorCentavos).toBe(120000); // 20% de 600000
    expect(body.netoCentavos).toBe(600000 - 120000 - 30000);
  });

  it("solo admin_gestora puede escribir un movimiento -- contador (solo-lectura) recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
      authedJson(ctx.staff.contador.token, { moneda: "MXN", montoBrutoCentavos: 100000, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] }),
    );
    expect(res.status).toBe(403);
  });

  it("un monto bruto decimal/no-entero se rechaza -- nunca flotante en el request", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
      authedJson(ctx.staff.adminGestora.token, { moneda: "MXN", montoBrutoCentavos: 1000.5, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("una reserva ya existente no admite un segundo movimiento (UNIQUE 1:1 real)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);
    const body = { moneda: "MXN", montoBrutoCentavos: 100000, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto" as const, gastos: [], impuestos: [] };

    const primero = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token, body));
    expect(primero.status).toBe(201);
    const segundo = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token, body));
    expect(segundo.status).toBe(500); // error interno real de integridad -- no es un 4xx de validación de forma
  });

  it("una ocupacionId inexistente en esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/reservas/00000000-0000-4000-8000-000000000000/movimiento`,
      authedJson(ctx.staff.adminGestora.token, { moneda: "MXN", montoBrutoCentavos: 100000, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /rentas/:propertyId/reservas/:ocupacionId/movimiento", () => {
  it("admin_gestora y contador pueden leer; operador:acceso_total NO", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);
    await app.request(
      `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
      authedJson(ctx.staff.adminGestora.token, { moneda: "MXN", montoBrutoCentavos: 100000, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] }),
    );

    const comoAdmin = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token));
    expect(comoAdmin.status).toBe(200);
    const comoContador = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.contador.token));
    expect(comoContador.status).toBe(200);
    const comoOperador = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.operadorAccesoTotal.token));
    expect(comoOperador.status).toBe(403);
  });

  it("sin movimiento registrado -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ocupacionId = await crearReservaDirecta(app, ctx);
    const res = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
  });
});
