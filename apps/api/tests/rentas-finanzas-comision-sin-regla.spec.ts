// Rn-18 -- una reserva de un canal externo SIN regla de comision responde un error de negocio
// claro (409 `comision_canal_sin_regla`) en lugar de una excepcion generica (500); una vez
// configurada la regla, el mismo movimiento se registra. Mismo patron de preparacion que
// rentas-payouts.spec.ts (la reserva de canal se crea con el motor de dominio).
import { describe, expect, it } from "vitest";
import { crearReservaConfirmada } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

async function crearReservaAirbnb(ctx: Awaited<ReturnType<typeof buildRentasTestContext>>): Promise<{ ocupacionId: string; canalId: string }> {
  const airbnb = await ctx.rentasRepo.findCanalPorCodigo("airbnb");
  if (!airbnb) throw new Error("catálogo sin canal airbnb");
  let ocupacionId!: string;
  await ctx.engine.withAppSession({ userId: null }, async (session) => {
    const resultado = await crearReservaConfirmada(session, {
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      rango: { inicio: "2026-10-01", fin: "2026-10-04" },
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: airbnb.id,
      externalId: "AIRBNB-SIN-REGLA",
    });
    ocupacionId = resultado.ocupacionId;
  });
  return { ocupacionId, canalId: airbnb.id };
}

const cuerpoMovimiento = { moneda: "MXN", montoBrutoCentavos: 100000, comisionGestorBasisPoints: 0, comisionGestorBase: "bruto", gastos: [], impuestos: [] };

describe("POST .../reservas/:ocupacionId/movimiento sin regla de comision (Rn-18)", () => {
  it("un canal externo sin regla responde 409 comision_canal_sin_regla con la accion a seguir, no un 500", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ocupacionId } = await crearReservaAirbnb(ctx);

    const res = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token, cuerpoMovimiento));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("comision_canal_sin_regla");
    expect(body.message).toMatch(/airbnb/i);
    expect(body.message).toMatch(/Finanzas/);
  });

  it("no deja ningun movimiento a medias: tras el 409 se puede reintentar al configurar la regla", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { ocupacionId, canalId } = await crearReservaAirbnb(ctx);

    const rechazado = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token, cuerpoMovimiento));
    expect(rechazado.status).toBe(409);
    const sinMovimiento = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, { headers: { authorization: `Bearer ${ctx.staff.adminGestora.token}` } });
    expect(sinMovimiento.status).toBe(404);

    ctx.rentasRepo.seedReglaComisionCanal({ propertyId: null, canalId, config: { yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "regla configurada por la gestora" } });
    const ok = await app.request(`/rentas/${ctx.propertyId}/reservas/${ocupacionId}/movimiento`, authedJson(ctx.staff.adminGestora.token, cuerpoMovimiento));
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { comisionCanalCentavos: number; comisionCanalFuente: string };
    expect(body.comisionCanalCentavos).toBe(15000);
    expect(body.comisionCanalFuente).toBe("regla configurada por la gestora");
  });
});
