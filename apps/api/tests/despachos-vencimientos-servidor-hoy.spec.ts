// REQ-r6 (seguimiento de PR #164, punto 1 -- LADO SERVIDOR): `vencimientos.ts`
// calculaba `todayIso()` como el día UTC del proceso -- entre las 18:00 y las
// 23:59 de America/Mexico_City (00:00-05:59 UTC) el servidor creía que ya era
// mañana, corriendo `diasRestantes` y `fechaPresentacion` (al completar) un día
// adelante del real. Fix: `todayIso()` ahora delega en
// `@atiende/core-tenancy::hoyFechaNegocio()` (ver su comentario de cabecera).
//
// Reproduce el bug real con `vi.setSystemTime` fijando el reloj del PROCESO en
// un instante UTC que cae en la ventana 18:00-23:59 CDMX -- exactamente el
// escenario de Vercel (`TZ=UTC`) que el hallazgo describe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

afterEach(() => {
  vi.useRealTimers();
});

// 2026-01-02T04:00:00Z = 2026-01-01T22:00:00 en America/Mexico_City (UTC-6 fijo).
const INSTANTE_22H_CDMX_DIA_1 = "2026-01-02T04:00:00.000Z";
const HOY_REAL_CDMX = "2026-01-01";
const MANANA_UTC_ROTO = "2026-01-02";

describe("GET /despachos/:propertyId/vencimientos -- diasRestantes usa el día de NEGOCIO, no el día UTC", () => {
  it("a las 22:00 CDMX, un vencimiento con fechaLimite = hoy real (2026-01-01) da diasRestantes: 0, nunca -1", async () => {
    const creado = await ctx.despachosRepo.createDeadline({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      tipo: "ISR",
      periodo: "2026-01",
      fechaLimite: HOY_REAL_CDMX,
      prioridad: "alta",
    });

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; diasRestantes: number }[];
    const fila = body.find((d) => d.id === creado.id);
    expect(fila).toBeDefined();
    // Control del bug: con el patrón viejo (día UTC), `fechaLimite` (hoy real)
    // habría quedado "ayer" respecto al `todayIso()` roto (mañana UTC) ->
    // diasRestantes -1. Con el fix, sigue siendo el mismo día -> 0.
    expect(fila!.diasRestantes).toBe(0);
  });

  it("POST .../calcular sin year/month explícitos usa el mes de NEGOCIO -- no el mes UTC (borde de fin de mes)", async () => {
    // 2026-01-31T23:00:00Z = 2026-01-31T17:00:00 en CDMX -- mismo día y mes en
    // ambas zonas todavía (no cae en el borde), sirve como control negativo del
    // caso límite real: 2026-02-01T04:00:00Z (22:00 CDMX del 31 de enero) SÍ cae en
    // el borde -- UTC ya es 1 de febrero, CDMX sigue en el 31 de enero.
    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T04:00:00.000Z")); // 22:00 CDMX del 31-ene

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { periodo: string }[];
    // No bloqueante #9 de la revisión de PR #171: `body.every(...)` pasaría trivialmente
    // en vacío si `calcular` no devolviera nada -- `calcularVencimientosDelPeriodo`
    // (engine.ts) siempre genera exactamente 4 (ISR, IVA, DIOT, Nómina), así que esta
    // aserción de longitud es la que de verdad obliga a que el arreglo no esté vacío.
    expect(body).toHaveLength(4);
    // Con el bug viejo (mes UTC), el periodo calculado por default habría sido
    // "2026-02" (ya es 1-feb en UTC). Con el fix, el mes de NEGOCIO (CDMX) sigue
    // siendo enero -> "2026-01".
    expect(body.every((d) => d.periodo === "2026-01")).toBe(true);
  });
});

describe("POST .../vencimientos/:id/completar -- fechaPresentacion usa el día de NEGOCIO", () => {
  it("completado a las 22:00 CDMX guarda fechaPresentacion = hoy real, no el día UTC (mañana)", async () => {
    const creado = await ctx.despachosRepo.createDeadline({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      tipo: "ISR",
      periodo: "2026-01",
      fechaLimite: "2026-01-05",
      prioridad: "alta",
    });

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_22H_CDMX_DIA_1));

    const res = await app.request(
      `/despachos/${ctx.propertyId}/vencimientos/${creado.id}/completar`,
      authedJson(ctx.staff.contador.token, {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fechaPresentacion: string | null };
    expect(body.fechaPresentacion).toBe(HOY_REAL_CDMX);
    expect(body.fechaPresentacion).not.toBe(MANANA_UTC_ROTO);
  });
});
