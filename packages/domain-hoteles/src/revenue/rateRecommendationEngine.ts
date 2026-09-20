// Fase 10 hoteles (motor de recomendaciones de tarifa, v1) — MOTOR DE CÓMPUTO:
// combina la señal de pickup (`pickupSignal.ts`), el calendario de
// eventos/temporada (`calendarioMexico.ts` + eventos locales de
// `hoteles.local_event`) y el compset manual (`hoteles.competitor_rate`),
// respetando el motor de reglas (`pricingRules.ts`), y produce el resultado que
// alimenta una fila de `hoteles.rate_recommendation` (incluido su desglose para
// la pantalla — "nunca una caja negra").
//
// Dominio puro, sin persistencia ni I/O: el llamador (el cron
// `apps/api/src/routes/verticals/hoteles/revenue-recommendations-cron.ts`, o
// cualquier caller manual) ya trajo del repositorio real (1) el resultado de
// `computePickupSignal`, (2) los eventos locales de la property que cubren la
// fecha, y (3) las tarifas de competidores capturadas para esa fecha.
//
// HEURÍSTICA DE COMBINACIÓN (v1, documentada aquí a propósito de la exigencia de
// honestidad del brief: NO es un modelo de elasticidad de precio calibrado con
// datos reales -- eso es evolución futura, ver README §Fase 10/knownGaps de la
// fase). Cada señal contribuye un % de ajuste sobre la tarifa BAR vigente,
// clamped individualmente para que ninguna señal por sí sola pueda disparar la
// tarifa fuera de un rango razonable ANTES incluso de que el motor de reglas
// (floor/ceiling) actúe como segunda guarda:
//
//   ajustePickupPct  = clamp(pickup.onTheBooksVsExpectedPct * pickupSensitivity, ±maxPickupAdjPct)
//                       -- 0 si `pickup.hasSufficientHistory` es false (REGLA:
//                       nunca se inventa una tendencia sin historia suficiente).
//   ajusteEventoPct  = clamp((impacto === 'alza_demanda' ? +1 : -1) * magnitudPct * eventoSensitivity, ±maxEventoAdjPct)
//                       -- 0 si ningún evento (federal/temporada/local) cubre la
//                       fecha. Si más de un evento cubre la misma fecha (ej. un
//                       evento local del staff coincide con un festivo federal),
//                       v1 usa el de MAYOR magnitud, nunca los suma -- evita que
//                       dos señales coincidentes disparen un ajuste sin límite
//                       (simplificación documentada, ver knownGaps de la fase).
//   ajusteCompsetPct = clamp(((medianaCompetidores - currentBarPrice) / currentBarPrice) * 100 * compsetPullFactor, ±maxCompsetAdjPct)
//                       -- "jala" la tarifa propia hacia la mediana capturada de
//                       competidores, nunca la iguala de golpe (pullFactor < 1) ni
//                       la sobrepasa (clamp). 0 si no hay ninguna captura de
//                       competidor para esta fecha (nunca se inventa un compset).
//
//   rawSuggestedPrice = currentBarPrice * (1 + (ajustePickupPct + ajusteEventoPct + ajusteCompsetPct) / 100)
//
// `rawSuggestedPrice` pasa entonces por `applyPricingRules()` (multiplicador por
// día de la semana + floor/ceiling) para obtener `recommendedPrice` final.
//
// Si NINGUNA señal disparó (pickup sin historia suficiente, sin evento, sin
// compset), este módulo NUNCA arma una `PriceRecommendationExplanation` vía
// `priceRecommendationExplainer.ts` (esa función exige >=1 factor, por diseño) --
// en su lugar devuelve `signalsStatus: "sin_señales"` con un texto fijo honesto,
// y el único ajuste que puede reflejarse en `recommendedPrice` es el del motor de
// reglas (multiplicador por día de semana / floor / ceiling), nunca una razón de
// mercado inventada.
// Nota: el motor NO invoca `computePickupSignal` directamente -- el llamador ya
// trae el `PickupSignalResult` calculado (ver `pickupSignal.ts`).
import type { PickupSignalResult } from "./pickupSignal.ts";
import { evaluateDemandaFecha } from "./calendarioMexico.ts";
import { applyPricingRules, assertValidPricingRules } from "./pricingRules.ts";
import type { PricingRules, PricingRuleApplication } from "./pricingRules.ts";
import {
  explainPriceRecommendation,
  assertValidPriceRecommendationInput,
  type PriceFactor,
  type PriceRecommendationExplanation,
} from "./priceRecommendationExplainer.ts";

export class RateRecommendationEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateRecommendationEngineError";
  }
}

export interface LocalEventInput {
  readonly nombre: string;
  /** Fechas ISO "YYYY-MM-DD", inclusive. */
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly impacto: "alza_demanda" | "baja_demanda";
  readonly magnitudPct: number;
}

export interface CompsetRateSample {
  readonly competidor: string;
  readonly tarifa: number;
}

export interface RateRecommendationSensitivities {
  readonly pickupSensitivity: number;
  readonly maxPickupAdjPct: number;
  readonly eventoSensitivity: number;
  readonly maxEventoAdjPct: number;
  readonly compsetPullFactor: number;
  readonly maxCompsetAdjPct: number;
}

/** Defaults de v1 -- heurísticos, no calibrados con datos reales (ver comentario
 *  de cabecera del módulo). Exportados para que la pantalla/tests puedan citarlos
 *  literalmente en vez de que vivan como números mágicos sin nombre. */
export const DEFAULT_SENSITIVITIES: RateRecommendationSensitivities = {
  pickupSensitivity: 0.3,
  maxPickupAdjPct: 15,
  eventoSensitivity: 0.5,
  maxEventoAdjPct: 20,
  compsetPullFactor: 0.5,
  maxCompsetAdjPct: 15,
};

export interface RateRecommendationSignalsInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly fecha: string;
  readonly currency: string;
  readonly currentBarPrice: number;
  readonly pickup: PickupSignalResult;
  /** Eventos locales de ESTA property que el staff ya registró y que cubren
   *  `fecha` -- el llamador filtra por rango, este módulo no vuelve a filtrar. */
  readonly localEvents: readonly LocalEventInput[];
  /** Tarifas de competidores capturadas MANUALMENTE por el staff para `fecha`
   *  (ver `hoteles.competitor_rate`) -- vacío si nadie ha capturado nada. */
  readonly competitorRates: readonly CompsetRateSample[];
  readonly pricingRules: PricingRules;
  readonly sensitivities?: Partial<RateRecommendationSensitivities>;
};

export type RateRecommendationSignalsStatus = "con_senales" | "sin_senales";

export interface RateRecommendationResult {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly fecha: string;
  readonly currentBarPrice: number;
  readonly recommendedPrice: number;
  readonly suggestedMinStay: number;
  readonly esAltaDemanda: boolean;
  readonly signalsStatus: RateRecommendationSignalsStatus;
  /** null cuando `signalsStatus === "sin_senales"` (ver comentario de cabecera:
   *  `explainPriceRecommendation` exige al menos un factor, nunca se fuerza). */
  readonly explanation: PriceRecommendationExplanation | null;
  /** Desglose COMPLETO -- listo para `jsonb` de `hoteles.rate_recommendation`.
   *  Incluye cada señal cruda (para que la pantalla pueda mostrar "pickup: +12%
   *  vs. histórico" aunque no haya disparado un factor de explicación) y la regla
   *  aplicada. */
  readonly desglose: {
    readonly pickup: PickupSignalResult;
    readonly evento: (LocalEventInput & { readonly fuente: "federal_o_temporada" | "local" }) | null;
    readonly compset: { readonly medianaCompetidores: number; readonly muestras: readonly CompsetRateSample[] } | null;
    readonly ajustes: { readonly pickupPct: number; readonly eventoPct: number; readonly compsetPct: number; readonly totalPct: number };
    readonly rawSuggestedPrice: number;
    readonly reglaAplicada: PricingRuleApplication;
  };
}

function clamp(value: number, maxAbs: number): number {
  return Math.max(-maxAbs, Math.min(maxAbs, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Combina el calendario de festivos/temporada (`calendarioMexico.ts`) con los
 *  eventos locales de la property para `fecha`, y elige UNO (mayor magnitud) --
 *  ver comentario de cabecera del módulo sobre por qué no se suman. */
function resolveEventoForFecha(
  fecha: string,
  localEvents: readonly LocalEventInput[],
): (LocalEventInput & { readonly fuente: "federal_o_temporada" | "local" }) | null {
  const candidates: Array<LocalEventInput & { readonly fuente: "federal_o_temporada" | "local" }> = [];

  const federal = evaluateDemandaFecha(fecha);
  if (federal.esAltaDemanda) {
    candidates.push({
      nombre: federal.eventos.join(", "),
      fechaInicio: fecha,
      fechaFin: fecha,
      impacto: "alza_demanda",
      // fechasExactas=false (solo puente_verano) se trata con menor magnitud --
      // heurística documentada, ver cabecera.
      magnitudPct: federal.fechasExactas ? 20 : 10,
      fuente: "federal_o_temporada",
    });
  }

  for (const ev of localEvents) {
    if (fecha >= ev.fechaInicio && fecha <= ev.fechaFin) {
      candidates.push({ ...ev, fuente: "local" });
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((max, c) => (c.magnitudPct > max.magnitudPct ? c : max));
}

export function computeRateRecommendation(input: RateRecommendationSignalsInput): RateRecommendationResult {
  if (!Number.isFinite(input.currentBarPrice) || input.currentBarPrice <= 0) {
    throw new RateRecommendationEngineError(`tarifa_bar_invalida: currentBarPrice debe ser un número positivo, recibido ${input.currentBarPrice}`);
  }
  assertValidPricingRules(input.pricingRules);
  for (const c of input.competitorRates) {
    if (!Number.isFinite(c.tarifa) || c.tarifa <= 0) {
      throw new RateRecommendationEngineError(`tarifa_competidor_invalida: debe ser un número positivo, recibido ${c.tarifa} (competidor "${c.competidor}")`);
    }
  }

  const s: RateRecommendationSensitivities = { ...DEFAULT_SENSITIVITIES, ...input.sensitivities };

  const pickupPct = input.pickup.hasSufficientHistory ? clamp(input.pickup.onTheBooksVsExpectedPct * s.pickupSensitivity, s.maxPickupAdjPct) : 0;

  const evento = resolveEventoForFecha(input.fecha, input.localEvents);
  const eventoPct = evento ? clamp((evento.impacto === "alza_demanda" ? 1 : -1) * evento.magnitudPct * s.eventoSensitivity, s.maxEventoAdjPct) : 0;

  const compsetMuestras = input.competitorRates;
  const compsetMediana = compsetMuestras.length > 0 ? median(compsetMuestras.map((c) => c.tarifa)) : null;
  const compsetPct = compsetMediana !== null ? clamp(((compsetMediana - input.currentBarPrice) / input.currentBarPrice) * 100 * s.compsetPullFactor, s.maxCompsetAdjPct) : 0;

  const totalPct = pickupPct + eventoPct + compsetPct;
  const rawSuggestedPrice = input.currentBarPrice * (1 + totalPct / 100);

  const demanda = evaluateDemandaFecha(input.fecha);
  const reglaAplicada = applyPricingRules(input.pricingRules, { fecha: input.fecha, rawSuggestedPrice, esAltaDemanda: demanda.esAltaDemanda });

  const factors: PriceFactor[] = [];
  if (input.pickup.hasSufficientHistory) {
    factors.push({ kind: "pickup", onTheBooksVsExpectedPct: input.pickup.onTheBooksVsExpectedPct });
  }
  if (evento) {
    factors.push({ kind: "evento", nombre: evento.nombre, impacto: evento.impacto, magnitudPct: evento.magnitudPct });
  }
  if (compsetMediana !== null) {
    factors.push({ kind: "compset", ownRateVsMedianPct: ((input.currentBarPrice - compsetMediana) / compsetMediana) * 100 });
  }

  let explanation: PriceRecommendationExplanation | null = null;
  const signalsStatus: RateRecommendationSignalsStatus = factors.length > 0 ? "con_senales" : "sin_senales";
  if (factors.length > 0) {
    const explanationInput = {
      hotelId: input.propertyId,
      fecha: input.fecha,
      currentPrice: input.currentBarPrice,
      recommendedPrice: reglaAplicada.finalPrice,
      currency: input.currency,
      factors,
    };
    assertValidPriceRecommendationInput(explanationInput);
    explanation = explainPriceRecommendation(explanationInput);
  }

  return {
    propertyId: input.propertyId,
    roomTypeId: input.roomTypeId,
    fecha: input.fecha,
    currentBarPrice: input.currentBarPrice,
    recommendedPrice: reglaAplicada.finalPrice,
    suggestedMinStay: reglaAplicada.suggestedMinStay,
    esAltaDemanda: demanda.esAltaDemanda,
    signalsStatus,
    explanation,
    desglose: {
      pickup: input.pickup,
      evento,
      compset: compsetMediana !== null ? { medianaCompetidores: compsetMediana, muestras: compsetMuestras } : null,
      ajustes: { pickupPct, eventoPct, compsetPct, totalPct },
      rawSuggestedPrice,
      reglaAplicada,
    },
  };
}
