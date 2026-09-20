// Lógica de datos del motor de revenue management (Fase 9, REQ-REV-003/004/005/007)
// — consume apps/api/src/routes/verticals/hoteles/revenue.ts. GAP REAL de esta
// fase (ver README de la rama): no existe ningún motor real que produzca
// recomendaciones de tarifa ni una tabla que las almacene -- lo que SÍ es real
// end-to-end aquí es el estado del gate (shadow/propone/autopilot), la aprobación
// explícita de "owner" para autopilot, y el historial de backtests walk-forward.
import { fetchJson, sendJson } from "./admin-client.ts";

export type RevenueGateState = "shadow" | "propone" | "autopilot";

export const REVENUE_GATE_STATE_LABELS: Record<RevenueGateState, string> = {
  shadow: "Shadow (solo registra)",
  propone: "Propone (requiere aprobación por cambio)",
  autopilot: "Autopilot (ejecuta directo)",
};

export interface RevenueGate {
  readonly id: string;
  readonly gate: RevenueGateState;
  readonly shadowStartedAt: string;
  readonly proponeStartedAt: string | null;
  readonly autopilotStartedAt: string | null;
  readonly proponeMaxVariationPct: number;
  readonly ownerApprovedAutopilotAt: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export type CounterfactualMethod = "misma_tarifa_periodo_anterior" | "tarifa_estatica_pre_motor" | "modelo_elasticidad_declarado";

export const COUNTERFACTUAL_METHOD_LABELS: Record<CounterfactualMethod, string> = {
  misma_tarifa_periodo_anterior: "Misma tarifa, periodo anterior",
  tarifa_estatica_pre_motor: "Tarifa estática pre-motor",
  modelo_elasticidad_declarado: "Modelo de elasticidad declarado",
};

export interface RevenueBacktestRun {
  readonly id: string;
  readonly counterfactualMethod: CounterfactualMethod;
  readonly windowsEvaluated: number;
  readonly windowsEngineWon: number;
  readonly engineTotalRevenue: number;
  readonly baselineTotalRevenue: number;
  readonly improvementPct: number;
  readonly passes: boolean;
  readonly failureReasons: readonly string[];
  readonly runBy: string | null;
  readonly runAt: string;
  readonly createdAt: string;
}

export async function fetchRevenueGate(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<RevenueGate | null> {
  const { gate } = await fetchJson<{ gate: RevenueGate | null }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/gate`, token);
  return gate;
}

export async function initRevenueGate(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<RevenueGate> {
  const { gate } = await sendJson<{ gate: RevenueGate }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/gate`, token, "POST", {});
  return gate;
}

export async function transitionRevenueGate(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, to: RevenueGateState): Promise<RevenueGate> {
  const { gate } = await sendJson<{ gate: RevenueGate }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/gate/transicion`, token, "POST", { to });
  return gate;
}

export async function setRevenueGateOwnerApproval(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, otorgar: boolean): Promise<RevenueGate> {
  const { gate } = await sendJson<{ gate: RevenueGate }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/gate/aprobacion-autopilot`, token, "POST", { otorgar });
  return gate;
}

export async function fetchRevenueBacktests(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RevenueBacktestRun[]> {
  return fetchJson<readonly RevenueBacktestRun[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/backtests`, token);
}

export interface RegisterBacktestInput {
  readonly counterfactualMethod: CounterfactualMethod;
  readonly evaluations: readonly {
    readonly window: { readonly trainStart: string; readonly trainEnd: string; readonly testStart: string; readonly testEnd: string };
    readonly engineRevenue: number;
    readonly baselineRevenue: number;
  }[];
}

export async function registerRevenueBacktest(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: RegisterBacktestInput): Promise<RevenueBacktestRun> {
  return sendJson<RevenueBacktestRun>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/backtests`, token, "POST", input);
}

// ---------------------------------------------------------------------------
// Fase 10 — motor de recomendaciones de tarifa v1 (packages/domain-hoteles/
// migrations/029_rate_recommendation_engine.sql +
// apps/api/.../revenue-recomendaciones.ts). Consume el desglose TAL CUAL lo
// arma el servidor (RateRecommendationResult.desglose) -- esta pantalla nunca
// reinterpreta ni resume las señales, solo las presenta: "nunca una caja negra".
// ---------------------------------------------------------------------------
export type RateRecommendationStatus = "pendiente" | "aprobada" | "aplicada" | "descartada" | "expirada";

export const RATE_RECOMMENDATION_STATUS_LABELS: Record<RateRecommendationStatus, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada (el sistema la aplicará)",
  aplicada: "Aplicada",
  descartada: "Descartada",
  expirada: "Expirada",
};

export interface RateRecommendation {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly fecha: string;
  readonly currentBarPrice: number;
  readonly recommendedPrice: number;
  readonly suggestedMinStay: number;
  readonly desglose: Record<string, unknown>;
  readonly estado: RateRecommendationStatus;
  readonly aprobadaPor: string | null;
  readonly aprobadaEn: string | null;
  readonly aplicadaPor: string | null;
  readonly aplicadaEn: string | null;
  readonly descartadaPor: string | null;
  readonly descartadaEn: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RateRecommendationCursor {
  readonly cursorFecha: string;
  readonly cursorRoomTypeId: string;
  readonly cursorId: string;
}

export async function fetchRateRecommendations(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { readonly estado?: RateRecommendationStatus; readonly limit?: number; readonly cursor?: RateRecommendationCursor } = {},
): Promise<{ readonly recomendaciones: readonly RateRecommendation[]; readonly nextCursor: RateRecommendationCursor | null }> {
  const params = new URLSearchParams();
  if (opts.estado) params.set("estado", opts.estado);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) {
    params.set("cursorFecha", opts.cursor.cursorFecha);
    params.set("cursorRoomTypeId", opts.cursor.cursorRoomTypeId);
    params.set("cursorId", opts.cursor.cursorId);
  }
  const qs = params.toString();
  return fetchJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/recomendaciones${qs ? `?${qs}` : ""}`, token);
}

export async function approveRateRecommendation(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<RateRecommendation> {
  return sendJson<RateRecommendation>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/recomendaciones/${id}/aprobar`, token, "POST", {});
}

export async function discardRateRecommendation(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<RateRecommendation> {
  return sendJson<RateRecommendation>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/recomendaciones/${id}/descartar`, token, "POST", {});
}

export interface PricingRule {
  readonly floorPrice: number;
  readonly ceilingPrice: number | null;
  readonly dayOfWeekMultiplier: readonly number[];
  readonly minStayDefault: number;
  readonly minStayOnHighDemand: number;
  readonly esDefault: boolean;
}

export async function fetchPricingRule(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, roomTypeId: string): Promise<PricingRule> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/pricing-rule/${roomTypeId}`, token);
}

export async function savePricingRule(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  roomTypeId: string,
  input: { readonly floorPrice: number; readonly ceilingPrice: number; readonly dayOfWeekMultiplier: readonly number[]; readonly minStayDefault: number; readonly minStayOnHighDemand: number },
): Promise<PricingRule> {
  return sendJson<PricingRule>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/pricing-rule/${roomTypeId}`, token, "PUT", input);
}

export interface LocalEvent {
  readonly id: string;
  readonly nombre: string;
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly impacto: "alza_demanda" | "baja_demanda";
  readonly magnitudPct: number;
}

export async function fetchLocalEvents(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, desde: string, hasta: string): Promise<readonly LocalEvent[]> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/local-events?desde=${desde}&hasta=${hasta}`, token);
}

export async function createLocalEvent(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly nombre: string; readonly fechaInicio: string; readonly fechaFin: string; readonly impacto: "alza_demanda" | "baja_demanda"; readonly magnitudPct: number },
): Promise<LocalEvent> {
  return sendJson<LocalEvent>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/local-events`, token, "POST", input);
}

export interface CompetitorRate {
  readonly id: string;
  readonly competidor: string;
  readonly fecha: string;
  readonly tarifa: number;
}

export async function fetchCompetitorRates(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha: string): Promise<readonly CompetitorRate[]> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/competitor-rates?fecha=${fecha}`, token);
}

export async function createCompetitorRate(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly competidor: string; readonly fecha: string; readonly tarifa: number },
): Promise<CompetitorRate> {
  return sendJson<CompetitorRate>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/revenue/competitor-rates`, token, "POST", input);
}
