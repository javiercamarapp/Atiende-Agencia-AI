// Test de integración end-to-end del flujo 2 (motor de cotización determinista, ver
// diseño Fase 1 rentas §4, Flujo 2) — HTTP real.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("GET /rentas/:propertyId/unidades/:unidadId/cotizacion", () => {
  it("cotiza 4 noches reales desde la tarifa base sembrada, sin descuento (no alcanza el umbral de 7 noches)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-05`,
      authedJson(ctx.staff.operadorSoloCalendario.token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { noches: number; subtotalAntesDescuentoCentavos: number; totalCentavos: number; descuentoAplicado: unknown };
    expect(body.noches).toBe(4);
    expect(body.subtotalAntesDescuentoCentavos).toBe(150000 * 4);
    expect(body.totalCentavos).toBe(150000 * 4);
    expect(body.descuentoAplicado).toBeNull();
  });

  it("una estadía de 7+ noches SÍ recibe el descuento por duración sembrado", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-08`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { noches: number; descuentoAplicado: { nochesMinimas: number } | null };
    expect(body.noches).toBe(7);
    expect(body.descuentoAplicado).not.toBeNull();
    expect(body.descuentoAplicado!.nochesMinimas).toBe(7);
  });

  it("un precio/total inyectado en la query es ignorado -- el guardia anti-alucinación es estructural (el endpoint ni siquiera lee ese parámetro)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02&totalCentavos=1&llmSuggestedPrice=1`,
      authedJson(ctx.staff.adminGestora.token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalCentavos: number };
    expect(body.totalCentavos).toBe(150000); // el precio real sembrado, nunca el "1" inyectado
  });

  it("checkOut anterior o igual a checkIn -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-05&checkOut=2026-06-01`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(400);
  });

  it("una unidad sin tarifa base configurada -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otraUnidadId = "00000000-0000-4000-8000-000000000001";
    ctx.rentasRepo.seedUnidad({ id: otraUnidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1 });
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${otraUnidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
  });

  it("cualquier miembro del staff con acceso a la property puede cotizar -- sin restricción de rol fino", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02`, authedJson(ctx.staff.operadorSoloCalendario.token));
    expect(res.status).toBe(200);
  });
});
