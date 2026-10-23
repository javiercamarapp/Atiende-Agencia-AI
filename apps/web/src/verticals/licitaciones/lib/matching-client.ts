// Lógica de datos de matching/go-no-go, lectura (Fase 7) — llama a
// `GET .../tenders/matching` (lista, todas las convocatorias con su score) y
// `GET .../tenders/:tenderId/matching` (detalle), Fase 3 pieza 2 (matching.ts).
// El score SIEMPRE se recalcula en vivo en el servidor contra el perfil de
// matching vigente -- este cliente nunca lo cachea más allá de la respuesta.
import { fetchJson } from "./admin-client.ts";

export type EligibilityStatus = "cumple" | "no_cumple" | "no_evaluable";

export interface EligibilityCriterionResult {
  readonly requirement: "budget" | "states" | "excludedKeywords";
  readonly status: EligibilityStatus;
  readonly explanation: string;
}

export interface EligibilityResult {
  readonly status: EligibilityStatus;
  readonly criteria: readonly EligibilityCriterionResult[];
}

export interface MatchCriterionResult {
  readonly criterion: "classifiers" | "keywords" | "budget" | "entities" | "states";
  readonly score: number;
  readonly maxScore: number;
  readonly explanation: string;
}

export interface MatchResult {
  readonly tenderId: string;
  readonly score: number;
  readonly criteria: readonly MatchCriterionResult[];
  readonly eligibility: EligibilityResult;
}

/** Puntaje de las convocatorias pedidas (`ids`) o de una pagina de las de plazo vigente. El servidor lo acota (techo 200): pasa `ids` de la pagina que se pinta. */
export async function fetchMatchingList(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { readonly ids?: readonly string[]; readonly limit?: number; readonly offset?: number } = {},
): Promise<readonly MatchResult[]> {
  const params = new URLSearchParams();
  if (opts.ids && opts.ids.length > 0) params.set("ids", opts.ids.join(","));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const body = await fetchJson<{ results: readonly MatchResult[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/matching${qs ? `?${qs}` : ""}`, token);
  return body.results;
}

export async function fetchMatchingDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<MatchResult> {
  return fetchJson<MatchResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/matching`, token);
}
