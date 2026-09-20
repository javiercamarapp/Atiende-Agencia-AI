// REQ-r6/f2-current-date-fecha-negocio (revisión del 19-sep): `loadPricingContext`
// resolvía "vigente hoy" con `current_date` (sesión de Postgres, UTC en Vercel) en vez
// del día de NEGOCIO -- entre las 18:00 y las 23:59 CDMX el día UTC ya es MAÑANA, así
// que una tarifa nueva programada para MAÑANA (CDMX) ya se cotizaba HOY, un día antes
// de tiempo. Fix: `PostgresRentasRepository.loadPricingContext`/
// `InMemoryRentasRepository.loadPricingContext` resuelven "hoy" con
// `@atiende/core-tenancy::hoyFechaNegocio()`. Mismo patrón de fake-clock que
// `rentas-pricing-servidor-hoy.spec.ts` (leído primero como plantilla).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T01:30:00Z = 2026-01-01T19:30:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_1930_CDMX_DIA_1 = "2026-01-02T01:30:00.000Z";

describe("GET /rentas/:propertyId/unidades/:unidadId/cotizacion -- 'vigente hoy' usa el día de NEGOCIO", () => {
  it("a las 19:30 CDMX, una tarifa nueva que arranca MAÑANA (día de negocio) NO se cotiza todavía, aunque el día UTC ya sea mañana", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    // La fixture ya siembra una tarifa vigente desde 2000-01-01 a $1,500.00/noche
    // (150000 centavos) -- ver rentas-fixtures.ts::seedPricingContext.
    const nueva = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 999999, moneda: "MXN", vigenteDesde: "2026-01-02" }),
    );
    expect(nueva.status).toBe(201);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_1930_CDMX_DIA_1));

    const cot = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02`, authedJson(ctx.staff.adminGestora.token));
    expect(cot.status).toBe(200);
    const body = (await cot.json()) as { totalCentavos: number };
    // Precio VIEJO (sembrado) -- la tarifa nueva (vigenteDesde 2026-01-02) todavía no
    // arranca en CDMX (día de negocio real: 2026-01-01).
    expect(body.totalCentavos).toBe(150000);
    expect(body.totalCentavos).not.toBe(999999);
  });

  it("un día después (2026-01-02, día de negocio real), la misma tarifa nueva SÍ se cotiza", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const nueva = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/tarifa-base`,
      authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 999999, moneda: "MXN", vigenteDesde: "2026-01-02" }),
    );
    expect(nueva.status).toBe(201);

    // 2026-01-03T01:30:00Z = 2026-01-02T19:30:00 en America/Mexico_City -- ya es
    // 2026-01-02 tanto en CDMX como en UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T01:30:00.000Z"));

    const cot = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/cotizacion?checkIn=2026-06-01&checkOut=2026-06-02`, authedJson(ctx.staff.adminGestora.token));
    expect(cot.status).toBe(200);
    const body = (await cot.json()) as { totalCentavos: number };
    expect(body.totalCentavos).toBe(999999);
  });
});
