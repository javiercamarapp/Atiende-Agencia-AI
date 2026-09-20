// Fase 10 hoteles — MOTOR DE CÓMPUTO del motor de recomendaciones de tarifa v1:
// cron que combina pickup (pickupSignal.ts, reconstruido de hoteles.reservation) +
// evento (calendarioMexico.ts + hoteles.local_event) + compset
// (hoteles.competitor_rate) respetando hoteles.pricing_rule
// (rateRecommendationEngine.ts), y produce/actualiza `hoteles.rate_recommendation`
// para las properties con `revenue_engine_gate` inicializado.
//
// SIEMPRE sesión de sistema (`engine.withAppSession({ userId: null }, ...)`, mismo
// patrón que night-audit.ts/email-dispatch.ts) — UNA transacción POR PROPERTY
// (r4-fix-crons-transaccion-por-unidad: una property con datos raros nunca debe
// revertir el cómputo de las demás).
//
// Comportamiento por gate (REQ del brief — NUNCA se salta):
//   - "shadow"/"propone": inserta la recomendación como "pendiente" y se detiene
//     ahí -- shadow es solo bitácora backtesteable, propone exige aprobación
//     humana antes de que CUALQUIER cosa aplique la tarifa.
//   - "autopilot": inserta la recomendación y, en la MISMA transacción, intenta
//     aplicarla directo vía `applyRateRecommendationAsSystem` -- el trigger real
//     (`rate_recommendation_status_guard`, migrations/029) es quien decide si es
//     elegible (backtest vigente que pasa + variación dentro del límite); si la
//     rechaza, la recomendación queda "pendiente" (nunca se reintenta a la fuerza,
//     nunca se enmascara el rechazo) y el barrido sigue con la siguiente fecha/
//     room_type.
//
// También expira (estado "expirada") las recomendaciones "pendiente"/"aprobada"
// cuya fecha ya pasó sin que nadie actuara -- limpieza de sistema, misma sesión.
import { Hono } from "hono";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import {
  computePickupSignal,
  computeRateRecommendation,
  DEFAULT_PRICING_RULES,
  type HotelesRepository,
  type PricingRules,
  type LocalEventInput,
  type CompsetRateSample,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** Horizonte de cómputo -- 45 días de anticipación es un rango razonable para un
 *  v1 (cubre la ventana donde pickup/eventos/compset son más accionables; un
 *  horizonte más largo es una decisión de producto futura, no un límite técnico de
 *  este motor). */
const HORIZON_DAYS = 45;
/** Ventana de historia usada para el fallback "cualquier_dia" de pickupSignal.ts --
 *  120 días (~17 semanas) alcanza para las 4 muestras mínimas del mismo día de la
 *  semana en la mayoría de los casos reales. */
const HISTORY_WINDOW_DAYS = 120;

function addDaysIso(fechaIso: string, days: number): string {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pricingRulesFromRecord(rule: Awaited<ReturnType<HotelesRepository["findPricingRule"]>>): PricingRules {
  if (!rule) return DEFAULT_PRICING_RULES;
  return {
    floorPrice: rule.floorPrice,
    ceilingPrice: rule.ceilingPrice,
    dayOfWeekMultiplier: rule.dayOfWeekMultiplier as unknown as PricingRules["dayOfWeekMultiplier"],
    minStayDefault: rule.minStayDefault,
    minStayOnHighDemand: rule.minStayOnHighDemand,
  };
}

export interface RateRecommendationSweepPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly skippedReason: "sin_gate_inicializado" | null;
  readonly fechasEvaluadas: number;
  readonly insertadas: number;
  readonly autoAplicadas: number;
  readonly autoAplicacionRechazada: number;
  readonly expiradas: number;
  readonly error: string | null;
}

async function sweepProperty(deps: AppDeps, organizationId: string, propertyId: string): Promise<RateRecommendationSweepPropertyResult> {
  try {
    return await deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const gate = await repo.findRevenueGate(propertyId);
      if (!gate) {
        return { organizationId, propertyId, skippedReason: "sin_gate_inicializado" as const, fechasEvaluadas: 0, insertadas: 0, autoAplicadas: 0, autoAplicacionRechazada: 0, expiradas: 0, error: null };
      }

      const today = hoyFechaNegocio();
      const roomTypes = await repo.listRoomTypes(propertyId);

      let fechasEvaluadas = 0;
      let insertadas = 0;
      let autoAplicadas = 0;
      let autoAplicacionRechazada = 0;

      for (const roomType of roomTypes) {
        const pricingRuleRecord = await repo.findPricingRule(roomType.id);
        const pricingRules = pricingRulesFromRecord(pricingRuleRecord);

        const historicalSamples = await repo.listPickupHistoricalSamples(
          propertyId,
          roomType.id,
          // Anticipación de referencia para la historia: la del PRIMER día del
          // horizonte (día 1) -- pickupSignal.ts solo usa `historicalSamples` como
          // pool bruto y filtra/promedia con su propia lógica; una única
          // anticipación de referencia es suficiente para un v1 (afinar la
          // anticipación exacta POR fecha del horizonte es una mejora futura, ver
          // knownGaps del PR).
          1,
          addDaysIso(today, -HISTORY_WINDOW_DAYS),
          addDaysIso(today, -1),
        );

        for (let leadTimeDays = 1; leadTimeDays <= HORIZON_DAYS; leadTimeDays++) {
          const fecha = addDaysIso(today, leadTimeDays);
          fechasEvaluadas += 1;

          if (await repo.hasActiveRateRecommendation(propertyId, roomType.id, fecha)) continue;

          const nightlyRates = await repo.loadNightlyRates(propertyId, roomType.id, fecha, fecha);
          const currentBarPrice = nightlyRates[0]?.price;
          if (currentBarPrice == null) continue; // "vacío honesto": sin tarifa BAR sembrada para esa noche, nunca se inventa un precio base.

          const onTheBooksNow = await repo.countOnTheBooksRoomsAsOf(propertyId, roomType.id, fecha, new Date().toISOString());
          const pickup = computePickupSignal({ fecha, leadTimeDays, onTheBooksRoomsNow: onTheBooksNow, historicalSamples });

          const localEventsRaw = await repo.listLocalEvents(propertyId, fecha, fecha);
          const localEvents: readonly LocalEventInput[] = localEventsRaw.map((e) => ({ nombre: e.nombre, fechaInicio: e.fechaInicio, fechaFin: e.fechaFin, impacto: e.impacto, magnitudPct: e.magnitudPct }));

          const competitorRatesRaw = await repo.listCompetitorRates(propertyId, fecha);
          const competitorRates: readonly CompsetRateSample[] = competitorRatesRaw.map((c) => ({ competidor: c.competidor, tarifa: c.tarifa }));

          const result = computeRateRecommendation({
            propertyId,
            roomTypeId: roomType.id,
            fecha,
            currency: "MXN",
            currentBarPrice,
            pickup,
            localEvents,
            competitorRates,
            pricingRules,
          });

          const inserted = await repo.insertRateRecommendationAsSystem({
            organizationId,
            propertyId,
            roomTypeId: roomType.id,
            fecha,
            currentBarPrice: result.currentBarPrice,
            recommendedPrice: result.recommendedPrice,
            suggestedMinStay: result.suggestedMinStay,
            desglose: result.desglose as unknown as Record<string, unknown>,
          });
          insertadas += 1;

          if (gate.gate === "autopilot") {
            try {
              await repo.applyRateRecommendationAsSystem(inserted.id);
              autoAplicadas += 1;
            } catch (err) {
              // El trigger real (migrations/029) rechazó la auto-aplicación (sin
              // backtest vigente, variación fuera de límite, etc.) -- se deja
              // "pendiente" para que quede visible en la pantalla, NUNCA se
              // reintenta a la fuerza ni se enmascara el rechazo.
              autoAplicacionRechazada += 1;
              console.warn(`revenue-recommendations-cron: auto-aplicación rechazada para ${inserted.id} (property ${propertyId}, ${fecha}):`, err instanceof Error ? err.message : err);
            }
          }
        }
      }

      const expirables = await repo.listExpirableRateRecommendationsAsSystem(propertyId);
      for (const rec of expirables) {
        await repo.expireRateRecommendationAsSystem(rec.id);
      }

      return { organizationId, propertyId, skippedReason: null, fechasEvaluadas, insertadas, autoAplicadas, autoAplicacionRechazada, expiradas: expirables.length, error: null };
    });
  } catch (err) {
    return {
      organizationId,
      propertyId,
      skippedReason: null,
      fechasEvaluadas: 0,
      insertadas: 0,
      autoAplicadas: 0,
      autoAplicacionRechazada: 0,
      expiradas: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runRateRecommendationSweep(deps: AppDeps): Promise<readonly RateRecommendationSweepPropertyResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: RateRecommendationSweepPropertyResult[] = [];
  for (const p of properties) {
    results.push(await sweepProperty(deps, p.organizationId, p.propertyId));
  }
  return results;
}

export function hotelesRevenueRecommendationsCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/revenue-recommendations", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/revenue-recommendations", async () => {
      const results = await runRateRecommendationSweep(deps);
      const failures = results.filter((r) => r.error != null);
      const body = {
        ok: failures.length === 0,
        properties_revisadas: results.length,
        corridas: results.map((r) => ({
          organizationId: r.organizationId,
          propertyId: r.propertyId,
          omitida: r.skippedReason,
          fechasEvaluadas: r.fechasEvaluadas,
          insertadas: r.insertadas,
          autoAplicadas: r.autoAplicadas,
          autoAplicacionRechazada: r.autoAplicacionRechazada,
          expiradas: r.expiradas,
          error: r.error,
        })),
      };
      const response = c.json(body, 200);
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_revenue_recommendations_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`revenue-recommendations: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
