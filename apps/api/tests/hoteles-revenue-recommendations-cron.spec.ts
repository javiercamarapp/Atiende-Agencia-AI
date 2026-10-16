// Fase 10 hoteles — motor de cómputo del motor de recomendaciones de tarifa:
// prueba el EFECTO REAL del barrido completo (pickup reconstruido de
// hoteles.reservation + evento + compset + reglas -> hoteles.rate_recommendation,
// y en autopilot -> hoteles.rate_plan real), no solo "no hubo 500".
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { runRateRecommendationSweep } from "../src/routes/verticals/hoteles/revenue-recommendations-cron.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

let ctx: HotelesTestContext;

function addDaysIso(fechaIso: string, days: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

describe("runRateRecommendationSweep — sin gate inicializado", () => {
  it("no calcula nada y lo marca 'sin_gate_inicializado' -- nunca inventa una recomendación para una property que no se enroló al motor", async () => {
    const results = await runRateRecommendationSweep(ctx.deps);
    const mine = results.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine.skippedReason).toBe("sin_gate_inicializado");
    expect(mine.insertadas).toBe(0);
  });
});

describe("runRateRecommendationSweep — gate 'shadow': registra pero NUNCA aplica", () => {
  it("inserta la recomendación 'pendiente' con desglose real y NO toca hoteles.rate_plan", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const today = hoyFechaNegocio();
    const fecha = addDaysIso(today, 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);

    const results = await runRateRecommendationSweep(ctx.deps);
    const mine = results.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine.error).toBeNull();
    expect(mine.insertadas).toBe(1);
    expect(mine.autoAplicadas).toBe(0);

    const recs = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 10 });
    const rec = recs.find((r) => r.fecha === fecha)!;
    expect(rec).toBeDefined();
    expect(rec.estado).toBe("pendiente");
    expect(rec.currentBarPrice).toBe(2000);
    expect(rec.desglose).toHaveProperty("pickup");
    expect(rec.desglose).toHaveProperty("reglaAplicada");

    const rates = await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha);
    expect(rates[0]!.price).toBe(2000); // sin cambio -- "shadow" nunca ejecuta nada.
  });

  it("nunca recalcula una fecha que ya tiene una decisión pendiente sin resolver", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const today = hoyFechaNegocio();
    const fecha = addDaysIso(today, 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);

    await runRateRecommendationSweep(ctx.deps);
    const results2 = await runRateRecommendationSweep(ctx.deps);
    const mine2 = results2.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine2.insertadas).toBe(0); // ya había una "pendiente" para esa fecha/room_type.

    const recs = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 10 });
    expect(recs.filter((r) => r.fecha === fecha)).toHaveLength(1);
  });

  it("sin tarifa BAR sembrada para esa noche, se salta la fecha (vacío honesto, nunca inventa un precio base)", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    // NO se siembra ninguna tarifa nueva -- solo las de la fixture base (2026-12-01..03,
    // 2025-01-10/11), ninguna dentro del horizonte de 45 días desde "hoy".
    const results = await runRateRecommendationSweep(ctx.deps);
    const mine = results.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine.insertadas).toBe(0);
  });

  it("un pickup fuerte por encima del histórico produce una recomendación que sube el precio", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const today = hoyFechaNegocio();
    const targetFecha = addDaysIso(today, 14);
    const targetWeekday = new Date(`${targetFecha}T00:00:00Z`).getUTCDay();
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: targetFecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);

    // Histórico: 4+ fechas pasadas del MISMO día de la semana, cada una con 1
    // reserva ya creada 14 días antes de esa fecha (misma anticipación que se está
    // evaluando ahora) -- pickup histórico esperado = 1.
    for (let weeksAgo = 1; weeksAgo <= 6; weeksAgo++) {
      const pastFecha = addDaysIso(targetFecha, -7 * weeksAgo);
      if (new Date(`${pastFecha}T00:00:00Z`).getUTCDay() !== targetWeekday) continue;
      ctx.hotelesRepo.seedReservation({
        id: randomUUID(),
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        roomTypeId: ctx.roomTypeId,
        guestId: null,
        checkInDate: pastFecha,
        checkOutDate: addDaysIso(pastFecha, 1),
        status: "confirmada",
        totalAmount: 2000,
        cancellationPenaltyAmount: null,
        canceledAt: null,
        createdAt: `${addDaysIso(pastFecha, -14)}T00:00:00.000Z`,
      });
    }
    // Ahora (a 14 días de anticipación del target): 4 reservas ya en libro --
    // muy por encima del histórico (1) -> pickup fuerte al alza.
    for (let i = 0; i < 4; i++) {
      ctx.hotelesRepo.seedReservation({
        id: randomUUID(),
        organizationId: ctx.organizationId,
        propertyId: ctx.propertyId,
        roomTypeId: ctx.roomTypeId,
        guestId: null,
        checkInDate: targetFecha,
        checkOutDate: addDaysIso(targetFecha, 1),
        status: "confirmada",
        totalAmount: 2000,
        cancellationPenaltyAmount: null,
        canceledAt: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      });
    }

    await runRateRecommendationSweep(ctx.deps);
    const recs = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 60 });
    const rec = recs.find((r) => r.fecha === targetFecha)!;
    expect(rec).toBeDefined();
    expect(rec.recommendedPrice).toBeGreaterThan(rec.currentBarPrice);
    const desglose = rec.desglose as { pickup?: { hasSufficientHistory?: boolean; onTheBooksVsExpectedPct?: number } };
    expect(desglose.pickup?.hasSufficientHistory).toBe(true);
    expect(desglose.pickup!.onTheBooksVsExpectedPct!).toBeGreaterThan(0);
  });
});

describe("runRateRecommendationSweep — gate 'autopilot': aplica de verdad dentro del límite, respeta el rechazo fuera de él", () => {
  async function seedAutopilotGateWithPassingBacktest() {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "autopilot", proponeMaxVariationPct: 15 });
    await ctx.hotelesRepo.insertRevenueBacktestRun({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      windowsEvaluated: 5,
      windowsEngineWon: 4,
      engineTotalRevenue: 1200,
      baselineTotalRevenue: 1000,
      improvementPct: 20,
      passes: true,
      failureReasons: [],
      detail: {},
      runBy: null,
    });
  }

  it("dentro del límite de variación: aplica DIRECTO y escribe hoteles.rate_plan de verdad", async () => {
    await seedAutopilotGateWithPassingBacktest();
    const today = hoyFechaNegocio();
    const fecha = addDaysIso(today, 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    // Sin señales fuertes -> el único ajuste real es el multiplicador DOW (dentro
    // del límite por diseño de DEFAULT_PRICING_RULES, +-15% default).

    const results = await runRateRecommendationSweep(ctx.deps);
    const mine = results.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine.error).toBeNull();
    expect(mine.insertadas).toBe(1);
    expect(mine.autoAplicadas).toBe(1);
    expect(mine.autoAplicacionRechazada).toBe(0);

    const recs = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { estado: "aplicada", limit: 10 });
    const rec = recs.find((r) => r.fecha === fecha)!;
    expect(rec).toBeDefined();
    expect(rec.aplicadaEn).not.toBeNull();
    expect(rec.aplicadaPor).toBeNull(); // aplicada por el sistema, nunca un humano.

    const rates = await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha);
    expect(rates[0]!.price).toBe(rec.recommendedPrice); // efecto REAL: la tarifa cambió de verdad.
  });

  it("fuera del límite de variación: se queda 'pendiente', el sistema NUNCA fuerza la aplicación", async () => {
    await seedAutopilotGateWithPassingBacktest();
    // Multiplicador DOW neutral -- aísla la prueba del día de la semana real en que
    // corra el test (con el default de fábrica, +-15%/+-20% de DOW podría por sí
    // solo empujar el resultado de vuelta dentro del límite algunos días).
    await ctx.hotelesRepo.upsertPricingRule(
      { propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, floorPrice: 0, ceilingPrice: 999999, dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1, 1], minStayDefault: 1, minStayOnHighDemand: 2 },
      ctx.staff.owner.id,
    );
    const today = hoyFechaNegocio();
    const fecha = addDaysIso(today, 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    // Un compset MUY por encima (capado en +15% por DEFAULT_SENSITIVITIES) MÁS un
    // evento local fuerte (otro +15% capado) -- combinados, 30% de ajuste bruto,
    // muy por encima del +-15% de propone_max_variation_pct, sin depender del día
    // de la semana real (DOW ya neutralizado arriba).
    await ctx.hotelesRepo.insertCompetitorRate({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, competidor: "Resort de Lujo Vecino", fecha, tarifa: 8000 }, ctx.staff.owner.id);
    await ctx.hotelesRepo.insertLocalEvent(
      { organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Congreso internacional", fechaInicio: fecha, fechaFin: fecha, impacto: "alza_demanda", magnitudPct: 90 },
      ctx.staff.owner.id,
    );

    const results = await runRateRecommendationSweep(ctx.deps);
    const mine = results.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mine.insertadas).toBe(1);
    expect(mine.autoAplicadas).toBe(0);
    expect(mine.autoAplicacionRechazada).toBe(1);

    const recs = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { estado: "pendiente", limit: 10 });
    expect(recs.find((r) => r.fecha === fecha)).toBeDefined();

    const rates = await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha);
    expect(rates[0]!.price).toBe(2000); // sin cambio -- el rechazo del trigger real se respeta.
  });
});

// FASE 3 (producto) — zona horaria por negocio (migrations/030_zona_horaria_property.sql):
// antes de esta fase, `sweepProperty` calculaba "hoy" SIEMPRE con
// `hoyFechaNegocio()` sin zona (default de plataforma) sin importar dónde estuviera
// la property real. Este bloque demuestra el EFECTO real, en el MISMO instante: una
// property en Cancún (UTC-5, sin horario de verano) calcula un "hoy" distinto que la
// misma property con la zona por defecto (CDMX, UTC-6) -- instante verificado con
// `Intl.DateTimeFormat` antes de escribir este test (ver comentario inline).
describe("FASE 3 — zona horaria por negocio: 'hoy' del motor de tarifas depende de la property, no del default de plataforma", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("con reloj falso, la MISMA property calcula un horizonte de fechas distinto según su zona configurada", async () => {
    // 2026-01-01T05:30:00.000Z == 2025-12-31 23:30 en America/Mexico_City (CDMX,
    // UTC-6) == 2026-01-01 00:30 en America/Cancun (UTC-5) -- "hoy" difiere un día
    // calendario completo en el MISMO instante real.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T05:30:00.000Z"));

    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });

    // Corrida 1 -- property SIN timezone configurada (cae al default de plataforma,
    // CDMX): "hoy" = 2025-12-31, así que leadTimeDays=1 evalúa la fecha 2026-01-01.
    const fechaCdmx = "2026-01-01";
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fechaCdmx, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    const resultsCdmx = await runRateRecommendationSweep(ctx.deps);
    const mineCdmx = resultsCdmx.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mineCdmx.insertadas).toBe(1);
    const recsAfterCdmx = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 50 });
    expect(recsAfterCdmx.find((r) => r.fecha === fechaCdmx)).toBeDefined();

    // Configura AHORA la property a Cancún (mismo endpoint que usaría owner/gm --
    // ver property-config.ts) -- MISMO instante real (el reloj falso no avanzó).
    await ctx.hotelesRepo.upsertPropertyTimezone(ctx.propertyId, ctx.organizationId, "America/Cancun", ctx.staff.owner.id);

    // Corrida 2 -- MISMO instante real, pero "hoy" ahora es 2026-01-01 (Cancún) --
    // leadTimeDays=1 evalúa la fecha 2026-01-02, un día DESPUÉS de la corrida CDMX.
    const fechaCancun = "2026-01-02";
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fechaCancun, price: 2200, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    const resultsCancun = await runRateRecommendationSweep(ctx.deps);
    const mineCancun = resultsCancun.find((r) => r.propertyId === ctx.propertyId)!;
    expect(mineCancun.insertadas).toBe(1); // solo la fecha NUEVA (fechaCdmx ya tiene una 'pendiente' sin resolver).

    const recsAfterCancun = await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 50 });
    expect(recsAfterCancun.find((r) => r.fecha === fechaCancun)).toBeDefined();
    // La recomendación de la corrida CDMX sigue ahí, intacta -- cambiar la zona de la
    // property no reescribe el pasado, solo cambia el "hoy" de las corridas futuras.
    expect(recsAfterCancun.find((r) => r.fecha === fechaCdmx)).toBeDefined();
  });
});

describe("GET /internal/hoteles/revenue-recommendations (cron HTTP)", () => {
  it("requiere el secreto interno", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/revenue-recommendations");
    expect(res.status).toBe(401);
  });

  it("corre el barrido y responde ok:true", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const app = buildApp(ctx.deps);
    const res = await app.request("/internal/hoteles/revenue-recommendations", { headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret! } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; properties_revisadas: number };
    expect(body.ok).toBe(true);
    expect(body.properties_revisadas).toBeGreaterThanOrEqual(1);
  });
});

// H-P3-02 (P0): la migracion 029 promete que en "propone" el staff aprueba y el cron de sistema APLICA lo aprobado en su
// siguiente corrida; antes el cron solo aplicaba en autopilot y al final EXPIRABA las aprobadas, asi que lo aprobado nunca llegaba
// a hoteles.rate_plan.
describe("runRateRecommendationSweep — aprobadas por staff en 'propone' se aplican (H-P3-02)", () => {
  async function sweepMine() {
    const results = await runRateRecommendationSweep(ctx.deps);
    return results.find((r) => r.propertyId === ctx.propertyId)!;
  }
  function seedRate(fecha: string, price = 2000) {
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
  }

  it("propone: una recomendacion aprobada se aplica de verdad a hoteles.rate_plan y queda 'aplicada' por el sistema", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone" });
    const fecha = addDaysIso(hoyFechaNegocio(), 10);
    seedRate(fecha);
    const first = await sweepMine();
    expect(first.insertadas).toBe(1);
    expect(first.aplicadasAprobadas).toBe(0); // nadie la aprobo todavia: sigue pendiente.
    const pendiente = (await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { estado: "pendiente", limit: 10 })).find((r) => r.fecha === fecha)!;
    expect((await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha))[0]!.price).toBe(2000);

    await ctx.hotelesRepo.approveRateRecommendation(pendiente.id, ctx.staff.owner.id);
    const second = await sweepMine();
    expect(second.error).toBeNull();
    expect(second.aplicadasAprobadas).toBe(1);
    expect(second.aplicacionRechazada).toBe(0);
    expect(second.expiradas).toBe(0);

    const aplicada = (await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { estado: "aplicada", limit: 10 })).find((r) => r.id === pendiente.id)!;
    expect(aplicada.aplicadaPor).toBeNull();
    expect((await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha))[0]!.price).toBe(pendiente.recommendedPrice);
  });

  it("shadow: una aprobada (p. ej. de antes de retroceder el gate) NO se aplica ni se cuenta", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const fecha = addDaysIso(hoyFechaNegocio(), 10);
    seedRate(fecha);
    await sweepMine();
    const rec = (await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { estado: "pendiente", limit: 10 })).find((r) => r.fecha === fecha)!;
    await ctx.hotelesRepo.approveRateRecommendation(rec.id, ctx.staff.owner.id);

    const mine = await sweepMine();
    expect(mine.aplicadasAprobadas).toBe(0);
    expect(mine.aplicacionRechazada).toBe(0);
    expect((await ctx.hotelesRepo.findRateRecommendation(rec.id))!.estado).toBe("aprobada");
    expect((await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha))[0]!.price).toBe(2000);
  });

  it("rechazo del trigger (variacion fuera del limite): se cuenta en aplicacionRechazada, queda 'aprobada' y no tumba la property", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone", proponeMaxVariationPct: 15 });
    const fecha = addDaysIso(hoyFechaNegocio(), 10);
    seedRate(fecha);
    const rec = await ctx.hotelesRepo.insertRateRecommendationAsSystem({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      roomTypeId: ctx.roomTypeId,
      fecha,
      currentBarPrice: 2000,
      recommendedPrice: 4000, // +100%: el limite vigente es +-15%
      suggestedMinStay: 1,
      desglose: {},
    });
    await ctx.hotelesRepo.approveRateRecommendation(rec.id, ctx.staff.owner.id);

    const mine = await sweepMine();
    expect(mine.error).toBeNull();
    expect(mine.aplicadasAprobadas).toBe(0);
    expect(mine.aplicacionRechazada).toBe(1);
    expect((await ctx.hotelesRepo.findRateRecommendation(rec.id))!.estado).toBe("aprobada");
    expect((await ctx.hotelesRepo.loadNightlyRates(ctx.propertyId, ctx.roomTypeId, fecha, fecha))[0]!.price).toBe(2000);
  });

  it("una aprobada de una fecha ya pasada no se aplica: expira (la aplicacion corre ANTES de expirar y solo toma fecha >= hoy)", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone" });
    const fechaPasada = addDaysIso(hoyFechaNegocio(), -3);
    const rec = await ctx.hotelesRepo.insertRateRecommendationAsSystem({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      roomTypeId: ctx.roomTypeId,
      fecha: fechaPasada,
      currentBarPrice: 2000,
      recommendedPrice: 2100,
      suggestedMinStay: 1,
      desglose: {},
    });
    await ctx.hotelesRepo.approveRateRecommendation(rec.id, ctx.staff.owner.id);

    const mine = await sweepMine();
    expect(mine.aplicadasAprobadas).toBe(0);
    expect(mine.expiradas).toBe(1);
    expect((await ctx.hotelesRepo.findRateRecommendation(rec.id))!.estado).toBe("expirada");
  });

  it("la lista de aprobadas por aplicar solo trae 'aprobada' con fecha >= hoy de ESA property", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone" });
    const hoy = hoyFechaNegocio();
    const mk = (fecha: string) =>
      ctx.hotelesRepo.insertRateRecommendationAsSystem({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, fecha, currentBarPrice: 2000, recommendedPrice: 2050, suggestedMinStay: 1, desglose: {} });
    const hoyRec = await mk(hoy);
    const futura = await mk(addDaysIso(hoy, 5));
    const pasada = await mk(addDaysIso(hoy, -1));
    const pendiente = await mk(addDaysIso(hoy, 6));
    for (const r of [hoyRec, futura, pasada]) await ctx.hotelesRepo.approveRateRecommendation(r.id, ctx.staff.owner.id);

    const ids = (await ctx.hotelesRepo.listApprovedRateRecommendationsAsSystem(ctx.propertyId, hoy)).map((r) => r.id);
    expect(ids).toEqual([hoyRec.id, futura.id]);
    expect(ids).not.toContain(pendiente.id);
    expect(await ctx.hotelesRepo.listApprovedRateRecommendationsAsSystem(randomUUID(), hoy)).toEqual([]);
  });
});

describe("aviso en la campana cuando el motor rechaza aplicar una aprobada (H-P3-02)", () => {
  it("emite hoteles.tarifa.aplicacion_rechazada UNA vez por property y dia, con la cantidad, sin PII y enlace a Revenue; sin rechazos no emite", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone", proponeMaxVariationPct: 15 });
    const hoy = hoyFechaNegocio();
    const fecha = addDaysIso(hoy, 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    const { deps, emisiones } = conEmisiones(ctx.deps);

    await runRateRecommendationSweep(deps);
    expect(emisiones.filter((e) => e.evento === "hoteles.tarifa.aplicacion_rechazada")).toHaveLength(0); // nada aprobado: nada que avisar

    const rec = await ctx.hotelesRepo.insertRateRecommendationAsSystem({
      organizationId: ctx.organizationId, propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, fecha: addDaysIso(hoy, 11), currentBarPrice: 2000, recommendedPrice: 4000, suggestedMinStay: 1, desglose: {},
    });
    await ctx.hotelesRepo.approveRateRecommendation(rec.id, ctx.staff.owner.id);
    await runRateRecommendationSweep(deps);
    const avisos = emisiones.filter((e) => e.evento === "hoteles.tarifa.aplicacion_rechazada");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      propertyId: ctx.propertyId,
      categoria: "operacion",
      cuerpo: "Aprobadas rechazadas por la guarda del motor: 1. Revísalas en Revenue.",
      enlace: "/hoteles/{orgSlug}/revenue",
      dedupeKey: `hoteles.tarifa.aplicacion_rechazada:${ctx.propertyId}:${hoy}`,
      roles: ["gm"],
    });
  });
});
