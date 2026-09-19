// Fase 9 hoteles (REQ-REV-003/004/005/007, P0/GOB) — wiring HTTP del motor de
// revenue management (pricing). GAP REAL verificado antes de esta fase (auditoría
// 18-sep): el dominio puro (`@atiende/domain-hoteles::revenue/*`) y su migración
// (`migrations/011_revenue_engine_gate.sql`, `hoteles.revenue_engine_gate`/
// `hoteles.revenue_backtest_run`) ya existían desde Fase 9, pero CERO invocador
// real -- ninguna ruta de `apps/api`, ni `HotelesRepository` tenía un solo método
// para ninguna de las dos tablas. Esta fase agrega esos métodos (ver
// `packages/domain-hoteles/src/{repository,postgres-repository,in-memory-repository}.ts`)
// y el primer invocador HTTP real.
//
// Autoridad de la máquina de estados: el trigger de Postgres
// (`hoteles.revenue_engine_gate_transition_guard`) sigue siendo quien de verdad
// decide si una transición es válida -- esta ruta llama primero
// `evaluateGateTransition()` (el mismo dominio puro, MISMA regla) para devolver un
// 409 explicado con las razones exactas de bloqueo ANTES de tocar la base, nunca
// para reemplazar al trigger.
//
// DELIBERADAMENTE fuera de esta fase (documentado, no fingido -- ver
// `packages/domain-hoteles/README.md` §Fase 9 y el reporte de esta misma rama): no
// existe ningún motor real que PRODUZCA una recomendación de tarifa (pickup/compset/
// evento/tipo de cambio reales), ninguna tabla que almacene "recomendaciones"
// individuales, y ninguna ruta que aplique una tarifa -- el original tampoco lo
// tenía en esta fase, y fabricar esa pieza sería una superficie de negocio nueva,
// no "wiring" de lo que ya existe. Lo que SÍ es real end-to-end aquí: el estado del
// gate (crear/consultar/transicionar/demover), la aprobación explícita de "owner"
// para autopilot, el registro/historial de backtests walk-forward, y 3 utilidades
// deterministas sin persistencia (explicación de precio, parity guard, admisión de
// benchmarking de compset) que un futuro motor de recomendación sí podría consumir.
// Ninguna aplica una tarifa saltándose el gate porque ninguna aplica una tarifa,
// punto.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  HOTEL_ROLES,
  REVENUE_GATE_MANAGE_ROLES,
  REVENUE_AUTOPILOT_APPROVAL_ROLES,
  REVENUE_BACKTEST_ROLES,
  REVENUE_GATE_STATES,
  evaluateGateTransition,
  evaluateWalkForwardBacktest,
  assertValidPriceRecommendationInput,
  explainPriceRecommendation,
  PriceExplanationError,
  assertValidParityGuardConfig,
  evaluateParityGuard,
  ParityGuardError,
  assertBenchmarkQueryAllowed,
  BenchmarkGuardError,
  type RevenueGateRecord,
  type RevenueGateState,
  type RevenueBacktestRunRecord,
  type CounterfactualMethod,
  type WindowEvaluation,
  type PriceRecommendationInput,
  type ParityGuardConfig,
  type BenchmarkQueryRequest,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const COUNTERFACTUAL_METHODS: readonly CounterfactualMethod[] = [
  "misma_tarifa_periodo_anterior",
  "tarifa_estatica_pre_motor",
  "modelo_elasticidad_declarado",
];

function serializeGate(gate: RevenueGateRecord) {
  return {
    id: gate.id,
    gate: gate.gate,
    shadowStartedAt: gate.shadowStartedAt,
    proponeStartedAt: gate.proponeStartedAt,
    autopilotStartedAt: gate.autopilotStartedAt,
    proponeMaxVariationPct: gate.proponeMaxVariationPct,
    ownerApprovedAutopilotAt: gate.ownerApprovedAutopilotAt,
    updatedBy: gate.updatedBy,
    updatedAt: gate.updatedAt,
    createdAt: gate.createdAt,
  };
}

function serializeBacktest(run: RevenueBacktestRunRecord) {
  return {
    id: run.id,
    counterfactualMethod: run.counterfactualMethod,
    windowsEvaluated: run.windowsEvaluated,
    windowsEngineWon: run.windowsEngineWon,
    engineTotalRevenue: run.engineTotalRevenue,
    baselineTotalRevenue: run.baselineTotalRevenue,
    improvementPct: run.improvementPct,
    passes: run.passes,
    failureReasons: run.failureReasons,
    detail: run.detail,
    runBy: run.runBy,
    runAt: run.runAt,
    createdAt: run.createdAt,
  };
}

interface WindowEvaluationBody {
  readonly window?: unknown;
  readonly engineRevenue?: unknown;
  readonly baselineRevenue?: unknown;
}

interface RegisterBacktestBody {
  readonly counterfactualMethod?: unknown;
  readonly evaluations?: readonly WindowEvaluationBody[];
  readonly minWindows?: unknown;
  readonly minImprovementPct?: unknown;
  readonly minWindowWinRatio?: unknown;
}

function parseEvaluations(raw: readonly WindowEvaluationBody[] | undefined): WindowEvaluation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Errors.validation("evaluations: se espera un arreglo no vacío de {window:{trainStart,trainEnd,testStart,testEnd}, engineRevenue, baselineRevenue}.");
  }
  return raw.map((e, i) => {
    const w = e.window as { trainStart?: unknown; trainEnd?: unknown; testStart?: unknown; testEnd?: unknown } | undefined;
    if (!w || typeof w.trainStart !== "string" || typeof w.trainEnd !== "string" || typeof w.testStart !== "string" || typeof w.testEnd !== "string") {
      throw Errors.validation(`evaluations[${i}].window: se esperan trainStart/trainEnd/testStart/testEnd como fechas ISO yyyy-mm-dd.`);
    }
    if (typeof e.engineRevenue !== "number" || !Number.isFinite(e.engineRevenue)) {
      throw Errors.validation(`evaluations[${i}].engineRevenue: se espera un número.`);
    }
    if (typeof e.baselineRevenue !== "number" || !Number.isFinite(e.baselineRevenue)) {
      throw Errors.validation(`evaluations[${i}].baselineRevenue: se espera un número.`);
    }
    return {
      window: { trainStart: w.trainStart, trainEnd: w.trainEnd, testStart: w.testStart, testEnd: w.testEnd },
      engineRevenue: e.engineRevenue,
      baselineRevenue: e.baselineRevenue,
    };
  });
}

export function hotelesRevenueRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/revenue/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/revenue", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- Estado del gate (transparencia: cualquier rol de staff de la property
  // puede verlo, mismo criterio que la policy de SELECT de migrations/011). ----
  app.get("/hoteles/:propertyId/revenue/gate", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const gate = await repo.findRevenueGate(c.req.param("propertyId"));
    return c.json({ gate: gate ? serializeGate(gate) : null }, 200);
  });

  // Inicializa el gate en "shadow" -- idempotente, siempre la única entrada
  // permitida por el trigger real (REQ-REV-003/BP-016).
  app.post("/hoteles/:propertyId/revenue/gate", async (c) => {
    assertVerticalRole(c, REVENUE_GATE_MANAGE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));
    const gate = await repo.ensureRevenueGate(propertyId, organizationId, userId);
    return c.json({ gate: serializeGate(gate) }, 200);
  });

  app.post("/hoteles/:propertyId/revenue/gate/transicion", async (c) => {
    assertVerticalRole(c, REVENUE_GATE_MANAGE_ROLES);
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = await readJsonCapped<{ to?: unknown }>(c.req.raw, 2 * 1024);
    const to = raw.to;
    if (typeof to !== "string" || !(REVENUE_GATE_STATES as readonly string[]).includes(to)) {
      throw Errors.validation(`to: se esperaba uno de ${REVENUE_GATE_STATES.join("|")}.`);
    }
    const toState = to as RevenueGateState;

    const current = await repo.findRevenueGate(propertyId);
    if (!current) throw Errors.revenueGateNoInicializado();

    const runs = await repo.listRevenueBacktestRuns(propertyId);
    const latestBacktest = runs[0]; // ya viene ordenado desc por runAt.
    const evaluation = evaluateGateTransition(current.gate, toState, {
      shadowStartedAt: new Date(current.shadowStartedAt),
      proponeStartedAt: current.proponeStartedAt ? new Date(current.proponeStartedAt) : undefined,
      backtest: latestBacktest
        ? {
            engineTotalRevenue: latestBacktest.engineTotalRevenue,
            baselineTotalRevenue: latestBacktest.baselineTotalRevenue,
            improvementPct: latestBacktest.improvementPct,
            windowsEvaluated: latestBacktest.windowsEvaluated,
            windowsEngineWon: latestBacktest.windowsEngineWon,
            windowWinRatio: latestBacktest.windowsEvaluated > 0 ? latestBacktest.windowsEngineWon / latestBacktest.windowsEvaluated : 0,
            counterfactualMethod: latestBacktest.counterfactualMethod,
            passes: latestBacktest.passes,
            failureReasons: latestBacktest.failureReasons,
          }
        : undefined,
      backtestRanAt: latestBacktest ? new Date(latestBacktest.runAt) : undefined,
      ownerApprovalGranted: current.ownerApprovedAutopilotAt != null,
    });

    if (!evaluation.allowed) {
      throw Errors.revenueGateTransicionBloqueada(evaluation.reasons);
    }

    const updated = await repo.updateRevenueGateState(propertyId, toState, userId);
    return c.json({ gate: serializeGate(updated) }, 200);
  });

  // Otorga/revoca la aprobación de "owner" que REQ-REV-003 (P0/GOB) exige antes de
  // habilitar autopilot pleno -- reservado a REVENUE_AUTOPILOT_APPROVAL_ROLES
  // (solo "owner", el trigger real lo reafirma con can_approve_revenue_autopilot).
  app.post("/hoteles/:propertyId/revenue/gate/aprobacion-autopilot", async (c) => {
    assertVerticalRole(c, REVENUE_AUTOPILOT_APPROVAL_ROLES);
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = await readJsonCapped<{ otorgar?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof raw.otorgar !== "boolean") throw Errors.validation("otorgar: se esperaba un booleano.");

    const current = await repo.findRevenueGate(propertyId);
    if (!current) throw Errors.revenueGateNoInicializado();
    if (raw.otorgar && current.gate !== "propone") {
      throw Errors.conflict('La aprobación de autopilot solo puede registrarse mientras el gate está en "propone".');
    }

    const updated = await repo.setRevenueGateOwnerApproval(propertyId, raw.otorgar, userId);
    return c.json({ gate: serializeGate(updated) }, 200);
  });

  // ---- Backtests walk-forward (REQ-REV-003: obligatorio antes de autopilot). ----
  app.get("/hoteles/:propertyId/revenue/backtests", async (c) => {
    assertVerticalRole(c, HOTEL_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const runs = await repo.listRevenueBacktestRuns(c.req.param("propertyId"));
    return c.json(runs.map(serializeBacktest));
  });

  app.post("/hoteles/:propertyId/revenue/backtests", async (c) => {
    assertVerticalRole(c, REVENUE_BACKTEST_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = await readJsonCapped<RegisterBacktestBody>(c.req.raw, 64 * 1024);
    if (typeof raw.counterfactualMethod !== "string" || !COUNTERFACTUAL_METHODS.includes(raw.counterfactualMethod as CounterfactualMethod)) {
      throw Errors.validation(`counterfactualMethod: se esperaba uno de ${COUNTERFACTUAL_METHODS.join("|")}.`);
    }
    const evaluations = parseEvaluations(raw.evaluations);
    for (const key of ["minWindows", "minImprovementPct", "minWindowWinRatio"] as const) {
      const v = raw[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
        throw Errors.validation(`${key}: se esperaba un número.`);
      }
    }

    const result = evaluateWalkForwardBacktest({
      evaluations,
      counterfactualMethod: raw.counterfactualMethod as CounterfactualMethod,
      minWindows: raw.minWindows as number | undefined,
      minImprovementPct: raw.minImprovementPct as number | undefined,
      minWindowWinRatio: raw.minWindowWinRatio as number | undefined,
    });

    const run = await repo.insertRevenueBacktestRun({
      organizationId,
      propertyId,
      counterfactualMethod: result.counterfactualMethod,
      windowsEvaluated: result.windowsEvaluated,
      windowsEngineWon: result.windowsEngineWon,
      engineTotalRevenue: result.engineTotalRevenue,
      baselineTotalRevenue: result.baselineTotalRevenue,
      improvementPct: result.improvementPct,
      passes: result.passes,
      failureReasons: result.failureReasons,
      detail: { evaluations },
      runBy: userId,
    });
    return c.json(serializeBacktest(run), 201);
  });

  // ---- Utilidades deterministas sin persistencia (insumo para un futuro motor de
  // recomendación, o para que un revenue manager arme/valide una propuesta a mano
  // antes de registrarla en cualquier sistema externo). ----
  app.post("/hoteles/:propertyId/revenue/explicacion-precio", async (c) => {
    assertVerticalRole(c, REVENUE_GATE_MANAGE_ROLES);
    const input = await readJsonCapped<PriceRecommendationInput>(c.req.raw, 16 * 1024);
    try {
      assertValidPriceRecommendationInput(input);
    } catch (err) {
      if (err instanceof PriceExplanationError) throw Errors.validation(err.message);
      throw err;
    }
    return c.json(explainPriceRecommendation(input), 200);
  });

  app.post("/hoteles/:propertyId/revenue/verificacion-paridad", async (c) => {
    assertVerticalRole(c, REVENUE_GATE_MANAGE_ROLES);
    const raw = await readJsonCapped<{ config?: ParityGuardConfig; proposedRate?: unknown }>(c.req.raw, 16 * 1024);
    if (!raw.config || typeof raw.proposedRate !== "number" || !Number.isFinite(raw.proposedRate)) {
      throw Errors.validation("Se esperaba {config, proposedRate: number}.");
    }
    try {
      assertValidParityGuardConfig(raw.config);
    } catch (err) {
      if (err instanceof ParityGuardError) throw Errors.validation(err.message);
      throw err;
    }
    return c.json(evaluateParityGuard(raw.config, raw.proposedRate), 200);
  });

  app.post("/hoteles/:propertyId/revenue/compset/verificacion", async (c) => {
    assertVerticalRole(c, REVENUE_GATE_MANAGE_ROLES);
    const input = await readJsonCapped<BenchmarkQueryRequest>(c.req.raw, 4 * 1024);
    try {
      assertBenchmarkQueryAllowed(input);
    } catch (err) {
      if (err instanceof BenchmarkGuardError) return c.json({ allowed: false, motivo: err.message }, 422);
      throw err;
    }
    return c.json({ allowed: true }, 200);
  });

  return app;
}
