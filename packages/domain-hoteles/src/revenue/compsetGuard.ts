// Fase 9 hoteles (REQ-REV-004, P0/GOB, fuente BP-055/BP-090): el motor de revenue no
// debe usar tarifas/ocupación no públicas de un solo hotel-cliente competidor;
// cualquier agregado de red de compset requiere k≥10 hoteles, ≥12 meses de histórico
// y ausencia de sub-estado identificable, con opinión antimonopolio previa
// documentada.
//
// Port literal de hoteles/packages/domain-hotel/src/compsetGuard.ts (verificado
// regla por regla contra el original: ninguna regla de negocio se cambió, solo las
// referencias de paquete/archivo de los comentarios).
//
// Esta función es la única puerta por la que una consulta de benchmarking de compset
// podría avanzar; no existe ninguna otra ruta de código en este paquete que agregue
// datos de competidores. Esta fase no construye el motor de revenue-benchmarking en
// sí (el que calcularía `CompsetFactor.ownRateVsMedianPct` de
// `priceRecommendationExplainer.ts`), solo esta guarda negativa -- exactamente el
// mismo alcance que el original documentaba para H4.
export class BenchmarkGuardError extends Error {
  code = "benchmark_k_minimo";
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkGuardError";
  }
}

export interface BenchmarkQueryRequest {
  /** Número de hoteles competidores distintos incluidos en el agregado (k). */
  competitorCount: number;
  monthsOfHistory: number;
  hasAntitrustOpinion: boolean;
}

const MIN_COMPETITORS = 10;
const MIN_MONTHS_HISTORY = 12;

export function assertBenchmarkQueryAllowed(req: BenchmarkQueryRequest): void {
  if (req.competitorCount < MIN_COMPETITORS) {
    throw new BenchmarkGuardError(
      `Se requieren al menos ${MIN_COMPETITORS} hoteles competidores en el agregado (recibidos: ${req.competitorCount}).`,
    );
  }
  if (req.monthsOfHistory < MIN_MONTHS_HISTORY) {
    throw new BenchmarkGuardError(
      `Se requieren al menos ${MIN_MONTHS_HISTORY} meses de histórico (recibidos: ${req.monthsOfHistory}).`,
    );
  }
  if (!req.hasAntitrustOpinion) {
    throw new BenchmarkGuardError(
      "Se requiere una opinión antimonopolio documentada antes de agregar datos de competidores.",
    );
  }
}
