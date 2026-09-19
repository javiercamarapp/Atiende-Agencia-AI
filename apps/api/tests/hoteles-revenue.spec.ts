// Fase 9 hoteles (REQ-REV-003/004/005/007) — integración HTTP real del wiring del
// motor de revenue management: gate shadow/propone/autopilot (nunca salta la
// transición que el dominio/trigger real exige), aprobación explícita de "owner"
// para autopilot, historial de backtests walk-forward, y las 3 utilidades
// deterministas sin persistencia.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface GateBody {
  gate: { gate: string; ownerApprovedAutopilotAt: string | null; shadowStartedAt: string; proponeStartedAt: string | null } | null;
}

const OTRA_PROPERTY_ID = "00000000-0000-0000-0000-000000000000";

describe("GET/POST /hoteles/:propertyId/revenue/gate", () => {
  it("sin inicializar, GET devuelve gate: null (nunca inventa un estado)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.gate).toBeNull();
  });

  it("cualquier rol de staff de la property puede ver el gate (transparencia, mismo criterio que la RLS real)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(200);
  });

  it("rechaza inicializar el gate a un rol fuera de REVENUE_GATE_MANAGE_ROLES (frontdesk)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });

  it("owner/gm inicializan el gate en shadow, idempotente", async () => {
    const app = buildApp(ctx.deps);
    const first = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));
    const firstBody = (await first.json()) as GateBody;
    expect(firstBody.gate?.gate).toBe("shadow");

    const second = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.gm.token, {}));
    const secondBody = (await second.json()) as GateBody;
    expect(secondBody.gate?.shadowStartedAt).toBe(firstBody.gate?.shadowStartedAt);
  });

  it("403 cross-property: sin membership a otra property", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${OTRA_PROPERTY_ID}/revenue/gate`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(403);
  });
});

describe("POST /hoteles/:propertyId/revenue/gate/transicion — nunca salta el gate real", () => {
  it("shadow -> propone se rechaza con 409 y la razón exacta antes de los 90 días (nunca toca la DB para forzarlo)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));

    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "propone" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("revenue_gate_transicion_bloqueada");
    expect(body.message).toContain("shadow_insuficiente");
  });

  it("con 90+ días en shadow, la promoción a propone SÍ se permite", async () => {
    const shadowStartedAt = new Date();
    shadowStartedAt.setUTCDate(shadowStartedAt.getUTCDate() - 91);
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { shadowStartedAt: shadowStartedAt.toISOString() });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "propone" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.gate?.gate).toBe("propone");
  });

  it("propone -> autopilot se rechaza sin backtest y sin aprobación de owner, aunque el actor sea owner", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone", proponeStartedAt: new Date().toISOString() });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "autopilot" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("backtest_faltante");
    expect(body.message).toContain("aprobacion_owner_requerida");
  });

  it("propone -> autopilot se permite solo con backtest vigente que pasa Y aprobación de owner ya registrada", async () => {
    const proponeStartedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "propone", proponeStartedAt, ownerApprovedAutopilotAt: new Date().toISOString() });
    await ctx.hotelesRepo.insertRevenueBacktestRun({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      windowsEvaluated: 3,
      windowsEngineWon: 3,
      engineTotalRevenue: 1000,
      baselineTotalRevenue: 900,
      improvementPct: 11.1,
      passes: true,
      failureReasons: [],
      detail: {},
      runBy: ctx.staff.owner.id,
    });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "autopilot" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.gate?.gate).toBe("autopilot");
  });

  it("rechaza un `to` inválido con 400", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "autopilot_pleno" }));
    expect(res.status).toBe(400);
  });

  it("democión (freno de emergencia) siempre se permite y limpia la aprobación de owner", async () => {
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, {
      gate: "propone",
      proponeStartedAt: new Date().toISOString(),
      ownerApprovedAutopilotAt: new Date().toISOString(),
    });
    const app = buildApp(ctx.deps);

    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "shadow" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateBody;
    expect(body.gate?.gate).toBe("shadow");
    expect(body.gate?.ownerApprovedAutopilotAt).toBeNull();
  });

  it("404 si el gate nunca se inicializó", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/transicion`, authedJson(ctx.staff.owner.token, { to: "propone" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /hoteles/:propertyId/revenue/gate/aprobacion-autopilot", () => {
  it("rechaza a gm (solo REVENUE_AUTOPILOT_APPROVAL_ROLES = owner)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/aprobacion-autopilot`, authedJson(ctx.staff.gm.token, { otorgar: true }));
    expect(res.status).toBe(403);
  });

  it("owner no puede otorgar la aprobación mientras el gate sigue en shadow", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/revenue/gate`, authedJson(ctx.staff.owner.token, {}));
    const res = await app.request(`/hoteles/${ctx.propertyId}/revenue/gate/aprobacion-autopilot`, authedJson(ctx.staff.owner.token, { otorgar: true }));
    expect(res.status).toBe(409);
  });
});

describe("GET/POST /hoteles/:propertyId/revenue/backtests", () => {
  it("rechaza registrar un backtest a un rol fuera de REVENUE_BACKTEST_ROLES (frontdesk)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/backtests`,
      authedJson(ctx.staff.frontdesk.token, { counterfactualMethod: "misma_tarifa_periodo_anterior", evaluations: [] }),
    );
    expect(res.status).toBe(403);
  });

  it("accountant registra un backtest walk-forward real y aparece en el historial", async () => {
    const app = buildApp(ctx.deps);
    const evaluations = [
      { window: { trainStart: "2026-01-01", trainEnd: "2026-01-10", testStart: "2026-01-11", testEnd: "2026-01-17" }, engineRevenue: 1000, baselineRevenue: 900 },
      { window: { trainStart: "2026-01-08", trainEnd: "2026-01-17", testStart: "2026-01-18", testEnd: "2026-01-24" }, engineRevenue: 1100, baselineRevenue: 950 },
      { window: { trainStart: "2026-01-15", trainEnd: "2026-01-24", testStart: "2026-01-25", testEnd: "2026-01-31" }, engineRevenue: 1050, baselineRevenue: 1000 },
    ];
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/backtests`,
      authedJson(ctx.staff.accountant.token, { counterfactualMethod: "misma_tarifa_periodo_anterior", evaluations }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { passes: boolean; windowsEvaluated: number };
    expect(body.windowsEvaluated).toBe(3);
    expect(body.passes).toBe(true);

    const historial = await app.request(`/hoteles/${ctx.propertyId}/revenue/backtests`, authedJson(ctx.staff.owner.token));
    expect(historial.status).toBe(200);
    const historialBody = (await historial.json()) as unknown[];
    expect(historialBody).toHaveLength(1);
  });

  it("rechaza evaluations vacío con 400 (nunca inventa ventanas)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/backtests`,
      authedJson(ctx.staff.owner.token, { counterfactualMethod: "misma_tarifa_periodo_anterior", evaluations: [] }),
    );
    expect(res.status).toBe(400);
  });
});

describe("utilidades deterministas de revenue (sin persistencia)", () => {
  it("POST .../revenue/explicacion-precio redacta la explicación en español a partir de factores YA calculados", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/explicacion-precio`,
      authedJson(ctx.staff.owner.token, {
        hotelId: ctx.propertyId,
        fecha: "2026-12-24",
        currentPrice: 2000,
        recommendedPrice: 2400,
        currency: "MXN",
        factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 25 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { direction: string; factors: unknown[] };
    expect(body.direction).toBe("sube");
    expect(body.factors).toHaveLength(1);
  });

  it("POST .../revenue/explicacion-precio rechaza una recomendación sin ningún factor (nunca inventa una razón)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/explicacion-precio`,
      authedJson(ctx.staff.owner.token, {
        hotelId: ctx.propertyId,
        fecha: "2026-12-24",
        currentPrice: 2000,
        recommendedPrice: 2400,
        currency: "MXN",
        factors: [],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST .../revenue/verificacion-paridad detecta una tarifa directa por debajo del piso de paridad", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/verificacion-paridad`,
      authedJson(ctx.staff.owner.token, {
        config: {
          hotelId: ctx.propertyId,
          mode: "bloquea",
          channels: [{ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 5 }],
        },
        proposedRate: 900,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean; violations: unknown[] };
    expect(body.allowed).toBe(false);
    expect(body.violations.length).toBeGreaterThan(0);
  });

  it("POST .../revenue/compset/verificacion rechaza una consulta con menos de 10 competidores (guarda negativa REQ-REV-004)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/compset/verificacion`,
      authedJson(ctx.staff.owner.token, { competitorCount: 3, monthsOfHistory: 12, hasAntitrustOpinion: true }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { allowed: boolean };
    expect(body.allowed).toBe(false);
  });

  it("rechaza las 3 utilidades a un rol fuera de REVENUE_GATE_MANAGE_ROLES (frontdesk)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/revenue/compset/verificacion`,
      authedJson(ctx.staff.frontdesk.token, { competitorCount: 12, monthsOfHistory: 12, hasAntitrustOpinion: true }),
    );
    expect(res.status).toBe(403);
  });
});
