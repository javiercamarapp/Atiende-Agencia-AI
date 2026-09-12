// Test de integración end-to-end del flujo 6 (Fase 2, alcance recortado) — payout de
// canal + conciliación: conciliado (por referencia), discrepancia, pendiente. Ver
// diseño Fase 2 rentas §5.
//
// No existe (a propósito, ver diseño §6.2) un endpoint HTTP de importación de reservas
// de canal en esta fase -- las reservas con canalOrigenId real se crean aquí llamando
// directo al motor de dominio (mismo patrón que packages/domain-rentas/tests/
// reservas.spec.ts), y su movimiento financiero sí se registra vía HTTP real
// (Flujo 3, Fase 1).
import { describe, expect, it } from "vitest";
import { crearReservaConfirmada } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

async function crearReservaDeCanal(
  ctx: Awaited<ReturnType<typeof buildRentasTestContext>>,
  canalId: string,
  rango: { inicio: string; fin: string },
  externalId: string,
): Promise<string> {
  let ocupacionId!: string;
  await ctx.engine.withAppSession({ userId: null }, async (session) => {
    const resultado = await crearReservaConfirmada(session, {
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      rango,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: canalId,
      externalId,
    });
    ocupacionId = resultado.ocupacionId;
  });
  return ocupacionId;
}

async function registrarMovimiento(app: ReturnType<typeof buildApp>, ctx: Awaited<ReturnType<typeof buildRentasTestContext>>, ocupacionId: string, montoBrutoCentavos: number) {
  const res = await app.request(
    `/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`,
    authedJson(ctx.staff.adminGestora.token, { moneda: "MXN", montoBrutoCentavos, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] }),
  );
  expect(res.status).toBe(201);
}

async function prepararReservasAirbnb(ctx: Awaited<ReturnType<typeof buildRentasTestContext>>, app: ReturnType<typeof buildApp>) {
  const airbnb = await ctx.rentasRepo.findCanalPorCodigo("airbnb");
  if (!airbnb) throw new Error("catálogo sin canal airbnb");
  // yaNetoDeComision=true (confirmado para Airbnb, Finanzas-1) -- montoRecibidoCentavos = montoBrutoCentavos.
  ctx.rentasRepo.seedReglaComisionCanal({ propertyId: null, canalId: airbnb.id, config: { yaNetoDeComision: true, comisionBasisPoints: 0, fuente: "Airbnb: net payout" } });

  const ocupacionA = await crearReservaDeCanal(ctx, airbnb.id, { inicio: "2026-09-01", fin: "2026-09-05" }, "AIRBNB-CONF-100");
  await registrarMovimiento(app, ctx, ocupacionA, 500000);

  const ocupacionB = await crearReservaDeCanal(ctx, airbnb.id, { inicio: "2026-09-10", fin: "2026-09-12" }, "AIRBNB-CONF-200");
  await registrarMovimiento(app, ctx, ocupacionB, 300000);

  return { airbnb, ocupacionA, ocupacionB };
}

describe("POST /rentas/:propertyId/payouts", () => {
  it("concilia por referencia externa cuando el monto coincide, deja pendiente lo que no matchea, y persiste el resumen", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await prepararReservasAirbnb(ctx, app);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, {
        canalCodigo: "airbnb",
        moneda: "MXN",
        fechaPayout: "2026-09-15",
        referenciaExterna: "PAYOUT-SEPT",
        lineas: [
          { referenciaExternaReserva: "AIRBNB-CONF-100", montoCentavos: 500000 },
          { referenciaExternaReserva: "NO-EXISTE-EN-ATIENDE", montoCentavos: 999999 },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; resumen: { conciliadas: number; pendientes: number; discrepancias: number } };
    expect(body.resumen).toEqual({ conciliadas: 1, pendientes: 1, discrepancias: 0 });

    const detalle = await app.request(`/rentas/${ctx.propertyId}/payouts/${body.id}`, authedJson(ctx.staff.contador.token));
    expect(detalle.status).toBe(200);
    const detalleBody = (await detalle.json()) as { resumen: { conciliadas: number }; lineas: Array<{ estado: string }> };
    expect(detalleBody.resumen.conciliadas).toBe(1);
    expect(detalleBody.lineas.find((l) => l.estado === "pendiente")).toBeTruthy();
  });

  it("discrepancia cuando la referencia coincide pero el monto no cuadra exacto -- nunca a ojo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await prepararReservasAirbnb(ctx, app);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, {
        canalCodigo: "airbnb",
        moneda: "MXN",
        fechaPayout: "2026-09-15",
        lineas: [{ referenciaExternaReserva: "AIRBNB-CONF-200", montoCentavos: 100 }],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resumen: { discrepancias: number } };
    expect(body.resumen.discrepancias).toBe(1);
  });

  it("sin referencia, concilia por monto exacto contra una candidata del canal correcto", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await prepararReservasAirbnb(ctx, app);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", moneda: "MXN", fechaPayout: "2026-09-15", lineas: [{ montoCentavos: 300000 }] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resumen: { conciliadas: number } };
    expect(body.resumen.conciliadas).toBe(1);
  });

  it("un canal desconocido -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.adminGestora.token, { canalCodigo: "canal-fantasma", moneda: "MXN", fechaPayout: "2026-09-15", lineas: [{ montoCentavos: 1000 }] }),
    );
    expect(res.status).toBe(404);
  });

  it("lineas vacío se rechaza -- 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/payouts`, authedJson(ctx.staff.adminGestora.token, { canalCodigo: "airbnb", moneda: "MXN", fechaPayout: "2026-09-15", lineas: [] }));
    expect(res.status).toBe(400);
  });

  it("operador (sin rol financiero) recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/payouts`,
      authedJson(ctx.staff.operadorAccesoTotal.token, { canalCodigo: "airbnb", moneda: "MXN", fechaPayout: "2026-09-15", lineas: [{ montoCentavos: 1000 }] }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /rentas/:propertyId/payouts/:id", () => {
  it("un id inexistente -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/payouts/00000000-0000-4000-8000-000000000000`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
  });
});
