// Fase 10 hoteles (motor de recomendaciones de tarifa, v1) — MOTOR DE REGLAS:
// floor/ceiling por room_type, multiplicador por día de la semana, y estancia
// mínima (LOS) sugerida en fechas de alta demanda. Dominio puro, sin
// persistencia -- el llamador (`rateRecommendationEngine.ts`) lee la
// configuración vigente de `hoteles.pricing_rule` (una fila por
// property/room_type, con defaults razonables si el owner no configuró nada,
// ver `DEFAULT_PRICING_RULES`) y aplica este módulo para acotar la tarifa
// SUGERIDA por las señales (pickup/evento/compset) ANTES de que se registre como
// `hoteles.rate_recommendation` -- "para que ninguna señal, junta o sola, tire el
// precio fuera de un rango que el owner definió" (alcance de esta fase).

export class PricingRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingRulesError";
  }
}

export interface PricingRules {
  readonly floorPrice: number;
  readonly ceilingPrice: number;
  /** Multiplicador aplicado sobre la tarifa base sugerida ANTES de acotar por
   *  floor/ceiling, uno por día de la semana (index 0 = domingo, igual que
   *  `Date.prototype.getUTCDay()`) -- ej. `[1.0, 0.9, 0.9, 0.9, 0.9, 1.15, 1.2]`
   *  sube viernes/sábado y baja entre semana. Todos deben ser > 0. */
  readonly dayOfWeekMultiplier: readonly [number, number, number, number, number, number, number];
  /** Estancia mínima (noches) sugerida cuando la fecha cae en alta demanda
   *  (`calendarioMexico.evaluateDemandaFecha().esAltaDemanda === true`). >= 1. */
  readonly minStayOnHighDemand: number;
  /** Estancia mínima (noches) sugerida en un día normal. >= 1, <= minStayOnHighDemand. */
  readonly minStayDefault: number;
}

/** Default razonable si el owner no configuró nada para esta property/room_type
 *  (REQ del brief: "Configurable por property, con default razonable si el owner
 *  no configuró nada"). Floor/ceiling son deliberadamente permisivos (±80%/+50%
 *  del valor que se está evaluando se calcula en el motor de cómputo, ver
 *  `rateRecommendationEngine.ts`) -- este default de aquí solo se usa cuando NO
 *  hay ninguna fila de `hoteles.pricing_rule`, así que debe ser conservador sin
 *  bloquear tarifas normales de ningún hotel mexicano típico. */
export const DEFAULT_PRICING_RULES: PricingRules = {
  floorPrice: 0,
  ceilingPrice: Number.POSITIVE_INFINITY,
  dayOfWeekMultiplier: [1.0, 0.95, 0.95, 0.95, 0.95, 1.1, 1.15],
  minStayOnHighDemand: 2,
  minStayDefault: 1,
};

export function assertValidPricingRules(rules: PricingRules): void {
  if (!Number.isFinite(rules.floorPrice) || rules.floorPrice < 0) {
    throw new PricingRulesError(`floor_invalido: floorPrice debe ser un número >= 0, recibido ${rules.floorPrice}`);
  }
  if (Number.isNaN(rules.ceilingPrice) || rules.ceilingPrice <= 0) {
    throw new PricingRulesError(`ceiling_invalido: ceilingPrice debe ser un número > 0, recibido ${rules.ceilingPrice}`);
  }
  if (rules.ceilingPrice < rules.floorPrice) {
    throw new PricingRulesError(`rango_invertido: ceilingPrice (${rules.ceilingPrice}) debe ser >= floorPrice (${rules.floorPrice})`);
  }
  if (rules.dayOfWeekMultiplier.length !== 7 || rules.dayOfWeekMultiplier.some((m) => !Number.isFinite(m) || m <= 0)) {
    throw new PricingRulesError("multiplicador_invalido: dayOfWeekMultiplier debe tener 7 valores numéricos > 0 (domingo..sábado)");
  }
  if (!Number.isInteger(rules.minStayDefault) || rules.minStayDefault < 1) {
    throw new PricingRulesError(`min_stay_default_invalido: debe ser un entero >= 1, recibido ${rules.minStayDefault}`);
  }
  if (!Number.isInteger(rules.minStayOnHighDemand) || rules.minStayOnHighDemand < rules.minStayDefault) {
    throw new PricingRulesError(
      `min_stay_alta_demanda_invalido: debe ser un entero >= minStayDefault (${rules.minStayDefault}), recibido ${rules.minStayOnHighDemand}`,
    );
  }
}

export interface PricingRuleApplication {
  readonly rawSuggestedPrice: number;
  readonly afterDayOfWeekMultiplier: number;
  readonly dayOfWeekMultiplierApplied: number;
  readonly finalPrice: number;
  readonly clampedByFloor: boolean;
  readonly clampedByCeiling: boolean;
  readonly suggestedMinStay: number;
}

function weekdayOfISODate(fecha: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new PricingRulesError(`fecha_invalida: se esperaba formato YYYY-MM-DD, recibido "${fecha}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * Aplica el multiplicador por día de la semana sobre `rawSuggestedPrice` (la
 * tarifa que las señales de pickup/evento/compset sugieren ANTES de reglas), y
 * acota el resultado a `[rules.floorPrice, rules.ceilingPrice]`. También decide
 * la estancia mínima sugerida según `esAltaDemanda`.
 */
export function applyPricingRules(rules: PricingRules, params: { readonly fecha: string; readonly rawSuggestedPrice: number; readonly esAltaDemanda: boolean }): PricingRuleApplication {
  assertValidPricingRules(rules);
  if (!Number.isFinite(params.rawSuggestedPrice) || params.rawSuggestedPrice < 0) {
    throw new PricingRulesError(`precio_sugerido_invalido: debe ser un número >= 0, recibido ${params.rawSuggestedPrice}`);
  }

  const weekday = weekdayOfISODate(params.fecha);
  const multiplier = rules.dayOfWeekMultiplier[weekday]!;
  const afterMultiplier = params.rawSuggestedPrice * multiplier;

  let finalPrice = afterMultiplier;
  let clampedByFloor = false;
  let clampedByCeiling = false;
  if (finalPrice < rules.floorPrice) {
    finalPrice = rules.floorPrice;
    clampedByFloor = true;
  }
  if (finalPrice > rules.ceilingPrice) {
    finalPrice = rules.ceilingPrice;
    clampedByCeiling = true;
  }

  const suggestedMinStay = params.esAltaDemanda ? rules.minStayOnHighDemand : rules.minStayDefault;

  return {
    rawSuggestedPrice: params.rawSuggestedPrice,
    afterDayOfWeekMultiplier: afterMultiplier,
    dayOfWeekMultiplierApplied: multiplier,
    finalPrice,
    clampedByFloor,
    clampedByCeiling,
    suggestedMinStay,
  };
}
