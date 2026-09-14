// Lógica de datos de decisiones go/no-go (Fase 7) — llama a
// `GET/POST .../tenders/:tenderId/go-no-go` (Fase 3 pieza 3, goNoGo.ts). El
// `MatchResult` que sustenta la decisión SIEMPRE se recalcula en el servidor en
// vivo -- este cliente nunca manda un score, solo `decision` + `reasons`.
import { fetchJson, postJson } from "./admin-client.ts";
import type { EligibilityStatus } from "./matching-client.ts";

export type GoNoGoDecisionValue = "go" | "no_go";

export interface GoNoGoDecision {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly decision: GoNoGoDecisionValue;
  readonly reasons: readonly string[];
  readonly matchScore: number;
  readonly matchEligibilityStatus: EligibilityStatus;
  readonly matchInputsHash: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export async function fetchGoNoGoDecisions(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly GoNoGoDecision[]> {
  const body = await fetchJson<{ decisions: readonly GoNoGoDecision[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/go-no-go`, token);
  return body.decisions;
}

export async function createGoNoGoDecision(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: { decision: GoNoGoDecisionValue; reasons: readonly string[] },
): Promise<GoNoGoDecision> {
  return postJson<GoNoGoDecision>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/go-no-go`, token, input);
}
