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
