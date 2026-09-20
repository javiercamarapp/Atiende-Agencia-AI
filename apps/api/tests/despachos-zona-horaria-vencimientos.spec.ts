// FASE 3 (producto) — zona horaria por negocio, parte despachos (migración 012,
// `despachos.property_config`). EFECTO real: hasta esta fase, `vencimientos.ts`
// SIEMPRE calculaba "hoy" con el default de plataforma (`America/Mexico_City`) --
// ninguna columna real existía todavía (ver `despachos-vencimientos-servidor-hoy.
// spec.ts`, que ya prueba el fix de "día UTC del proceso" vs. "día de negocio", pero
// siempre contra el default). Este archivo prueba la pieza NUEVA: conectar la zona
// horaria REAL de la property cambia "hoy" quando esa zona difiere del default.
//
// Instante elegido (verificado con Intl.DateTimeFormat ANTES de escribir el test,
// nunca asumido):
//   new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" })
//     .format(new Date("2026-01-02T05:30:00.000Z")) === "2026-01-01"
//   new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cancun" })
//     .format(new Date("2026-01-02T05:30:00.000Z")) === "2026-01-02"
// A las 05:30 UTC, Cancún (UTC-5, sin horario de verano desde 2015) YA cruzó a
// "mañana" mientras CDMX (UTC-6 fijo) sigue en "hoy" -- una ventana real de 1 hora
// (05:00-05:59 UTC) donde ambas zonas discrepan sobre qué día es.
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

const INSTANTE_0530_UTC = "2026-01-02T05:30:00.000Z";
const HOY_CDMX = "2026-01-01";
const HOY_CANCUN = "2026-01-02";

describe("GET /despachos/:propertyId/vencimientos -- conecta la zona horaria REAL de la property (migración 012)", () => {
  it("sin configuración (fila ausente en property_config) -- sigue usando el default de plataforma (CDMX)", async () => {
    const creado = await ctx.despachosRepo.createDeadline({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      tipo: "ISR",
      periodo: "2026-01",
      fechaLimite: HOY_CDMX,
      prioridad: "alta",
    });

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_0530_UTC));

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const body = (await res.json()) as { id: string; diasRestantes: number }[];
    expect(body.find((d) => d.id === creado.id)!.diasRestantes).toBe(0); // "hoy" real de CDMX == fechaLimite -> 0.
  });

  it("EFECTO real: property configurada en America/Cancun ve 'hoy' un día ADELANTE del default, exactamente cuando Cancún ya cruzó de día y CDMX no", async () => {
    await ctx.despachosRepo.upsertPropertyConfigZonaHoraria(ctx.propertyId, ctx.organizationId, "America/Cancun");
    const creado = await ctx.despachosRepo.createDeadline({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      tipo: "ISR",
      periodo: "2026-01",
      fechaLimite: HOY_CANCUN, // el vencimiento real es "hoy" en Cancún.
      prioridad: "alta",
    });

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_0530_UTC));

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const body = (await res.json()) as { id: string; diasRestantes: number }[];
    // Contra el bug (zona horaria nunca conectada, siempre CDMX): "hoy" habría sido
    // HOY_CDMX (un día ANTES del real de Cancún) -> diasRestantes: 1 (todavía no
    // vence). Con la conexión real, "hoy" es HOY_CANCUN -> vence HOY -> 0.
    expect(body.find((d) => d.id === creado.id)!.diasRestantes).toBe(0);
  });

  it("POST .../:id/completar guarda fechaPresentacion en el día de Cancún, no en el de CDMX", async () => {
    await ctx.despachosRepo.upsertPropertyConfigZonaHoraria(ctx.propertyId, ctx.organizationId, "America/Cancun");
    const creado = await ctx.despachosRepo.createDeadline({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      tipo: "IVA",
      periodo: "2026-01",
      fechaLimite: "2026-01-05",
      prioridad: "media",
    });

    const app = buildApp(ctx.deps);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INSTANTE_0530_UTC));

    const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${creado.id}/completar`, authedJson(ctx.staff.contador.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fechaPresentacion: string | null };
    expect(body.fechaPresentacion).toBe(HOY_CANCUN);
    expect(body.fechaPresentacion).not.toBe(HOY_CDMX);
  });
});
