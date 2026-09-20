// Fase 10 hoteles (motor de recomendaciones de tarifa, v1) — SEÑAL DE PICKUP
// (pacing). Dominio puro: NUNCA toca la base de datos, recibe ya calculados el
// "on the books" actual y una lista de muestras históricas (el llamador -- el
// motor de cómputo, `rateRecommendationEngine.ts` -- las obtiene de
// `hoteles.availability`/reservas vía el repositorio real, ver
// `HotelesRepository.loadPickupHistoricalSamples` /
// `HotelesRepository.countOnTheBooksRooms`).
//
// FÓRMULA EXACTA (documentada aquí, no solo en un comentario de PR, porque el
// dueño necesita poder auditarla desde la pantalla de "por qué este precio"):
//
//   pickup_actual = habitaciones en libro (`sum(booked_rooms)` de
//     `hoteles.availability` para la property/fecha objetivo) medido HOY, es
//     decir a `leadTimeDays` días de anticipación de la fecha objetivo.
//
//   pickup_esperado = promedio de `pickup_actual` medido a la MISMA anticipación
//     (mismo `leadTimeDays`) en fechas pasadas comparables:
//       1) preferentemente, fechas pasadas del MISMO día de la semana que la
//          fecha objetivo (asume que la estacionalidad semanal es más relevante
//          que la calendárica para pacing de corto plazo) -- si hay al menos
//          `minSameWeekdaySamples` muestras así, esa es la base de comparación.
//       2) si no hay suficiente historia del mismo día de la semana, cae a
//          CUALQUIER fecha pasada a la misma anticipación (mezcla días de la
//          semana) -- solo si hay al menos `minAnySamples` muestras.
//       3) si ni eso alcanza: SIN SEÑAL -- nunca se inventa una tendencia con
//          menos de `minAnySamples` puntos. Se devuelve `hasSufficientHistory:
//          false`, `onTheBooksVsExpectedPct: 0` (neutral, no "sube" ni "baja") y
//          `basis: "sin_historia_suficiente"` -- el motor de cómputo debe tratar
//          esto como "sin opinión de pickup", NUNCA como "pickup normal".
//
//   onTheBooksVsExpectedPct = ((pickup_actual - pickup_esperado) / pickup_esperado) * 100
//     -- MISMA definición y mismo signo que `PickupFactor.onTheBooksVsExpectedPct`
//     de `priceRecommendationExplainer.ts` (positivo = pickup por encima de lo
//     esperado = empuja el precio al alza), para que este módulo alimente ese
//     explicador sin ninguna traducción intermedia.
//
// LÍMITE documentado (property nueva o con muy poca historia): si
// `pickup_esperado` es 0 (nunca hubo ninguna reserva a esa anticipación en el
// histórico usado), un cambio porcentual normal es indefinido (división entre
// cero) -- se usa un valor fijo conservador (+100% si SÍ hay reservas ahora, 0%
// si tampoco las hay ahora) en vez de `Infinity`/`NaN`, documentado explícitamente
// en el resultado (`expectedWasZero: true`) para que el motor de reglas pueda
// amortiguar esta señal si lo considera necesario.

export class PickupSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickupSignalError";
  }
}

export interface PickupHistoricalSample {
  /** Fecha (noche) histórica ISO "YYYY-MM-DD" a la que corresponde la muestra --
   *  solo se usa para derivar el día de la semana, nunca se compara directamente
   *  con la fecha objetivo. */
  readonly fecha: string;
  /** Habitaciones en libro que había para esa fecha histórica, medidas a la MISMA
   *  anticipación (`leadTimeDays`) que la medición actual. */
  readonly onTheBooksRooms: number;
}

export type PickupBasis = "mismo_dia_semana" | "cualquier_dia" | "sin_historia_suficiente";

export interface PickupSignalInput {
  readonly fecha: string;
  /** Días de anticipación de la medición ACTUAL respecto a "hoy" (>= 0). */
  readonly leadTimeDays: number;
  readonly onTheBooksRoomsNow: number;
  /** Muestras históricas YA filtradas por el llamador a la misma anticipación
   *  (`leadTimeDays`) -- este módulo solo decide, de esas, cuáles usar según día
   *  de la semana. */
  readonly historicalSamples: readonly PickupHistoricalSample[];
  /** Mínimo de muestras del MISMO día de la semana para usarlas como base
   *  preferente. Default 4 (aprox. un mes de historia semanal). */
  readonly minSameWeekdaySamples?: number;
  /** Mínimo de muestras (cualquier día) para el fallback (2). Default 8. */
  readonly minAnySamples?: number;
  /** Umbral, en %, a partir del cual la señal se considera lo bastante fuerte
   *  para recomendar subir/bajar en vez de "mantener". Default 10. */
  readonly recommendationThresholdPct?: number;
}

export type PickupRecommendation = "subir_tarifa" | "bajar_tarifa_o_promocion" | "mantener";

export interface PickupSignalResult {
  readonly fecha: string;
  readonly leadTimeDays: number;
  readonly onTheBooksRoomsNow: number;
  readonly basis: PickupBasis;
  readonly sampleSize: number;
  readonly hasSufficientHistory: boolean;
  /** null cuando `hasSufficientHistory` es false. */
  readonly expectedOnTheBooksRooms: number | null;
  /** Ver comentario de cabecera del módulo -- 0 cuando `hasSufficientHistory` es
   *  false (nunca se inventa una tendencia). */
  readonly onTheBooksVsExpectedPct: number;
  readonly expectedWasZero: boolean;
  readonly recommendation: PickupRecommendation;
}

function weekdayOfISODate(fecha: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) throw new PickupSignalError(`fecha_invalida: se esperaba formato YYYY-MM-DD, recibido "${fecha}"`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Calcula la señal de pickup para `input.fecha` a partir del on-the-books actual y
 * el histórico comparable. Nunca lanza por falta de historia -- ver el criterio de
 * fallback conservador documentado en la cabecera del módulo; sí lanza
 * `PickupSignalError` por entradas inválidas (fecha mal formada, números
 * negativos/no finitos).
 */
export function computePickupSignal(input: PickupSignalInput): PickupSignalResult {
  if (!Number.isInteger(input.leadTimeDays) || input.leadTimeDays < 0) {
    throw new PickupSignalError(`lead_time_invalido: leadTimeDays debe ser un entero >= 0, recibido ${input.leadTimeDays}`);
  }
  if (!Number.isFinite(input.onTheBooksRoomsNow) || input.onTheBooksRoomsNow < 0) {
    throw new PickupSignalError(`on_the_books_invalido: debe ser un número >= 0, recibido ${input.onTheBooksRoomsNow}`);
  }
  for (const s of input.historicalSamples) {
    if (!Number.isFinite(s.onTheBooksRooms) || s.onTheBooksRooms < 0) {
      throw new PickupSignalError(`muestra_historica_invalida: onTheBooksRooms debe ser un número >= 0, recibido ${s.onTheBooksRooms} (fecha ${s.fecha})`);
    }
  }

  const minSameWeekdaySamples = input.minSameWeekdaySamples ?? 4;
  const minAnySamples = input.minAnySamples ?? 8;
  const thresholdPct = input.recommendationThresholdPct ?? 10;

  const targetWeekday = weekdayOfISODate(input.fecha);
  const sameWeekday = input.historicalSamples.filter((s) => weekdayOfISODate(s.fecha) === targetWeekday);

  let basis: PickupBasis;
  let samples: readonly PickupHistoricalSample[];
  if (sameWeekday.length >= minSameWeekdaySamples) {
    basis = "mismo_dia_semana";
    samples = sameWeekday;
  } else if (input.historicalSamples.length >= minAnySamples) {
    basis = "cualquier_dia";
    samples = input.historicalSamples;
  } else {
    basis = "sin_historia_suficiente";
    samples = [];
  }

  if (basis === "sin_historia_suficiente") {
    return {
      fecha: input.fecha,
      leadTimeDays: input.leadTimeDays,
      onTheBooksRoomsNow: input.onTheBooksRoomsNow,
      basis,
      sampleSize: 0,
      hasSufficientHistory: false,
      expectedOnTheBooksRooms: null,
      onTheBooksVsExpectedPct: 0,
      expectedWasZero: false,
      recommendation: "mantener",
    };
  }

  const expected = mean(samples.map((s) => s.onTheBooksRooms));
  const expectedWasZero = expected === 0;
  const pct = expectedWasZero ? (input.onTheBooksRoomsNow > 0 ? 100 : 0) : ((input.onTheBooksRoomsNow - expected) / expected) * 100;

  const recommendation: PickupRecommendation = pct >= thresholdPct ? "subir_tarifa" : pct <= -thresholdPct ? "bajar_tarifa_o_promocion" : "mantener";

  return {
    fecha: input.fecha,
    leadTimeDays: input.leadTimeDays,
    onTheBooksRoomsNow: input.onTheBooksRoomsNow,
    basis,
    sampleSize: samples.length,
    hasSufficientHistory: true,
    expectedOnTheBooksRooms: expected,
    onTheBooksVsExpectedPct: pct,
    expectedWasZero,
    recommendation,
  };
}
