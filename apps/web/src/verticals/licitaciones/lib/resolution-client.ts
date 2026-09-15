// Lógica de datos de la resolución won/lost (Fase 16, post-adjudicación) —
// llama a `GET/POST .../tenders/:tenderId/resolution` (resolution.ts). Marcar
// una convocatoria ganada/perdida es el ÚNICO camino real que la hace
// alcanzable "won"/"lost" -- sin este endpoint (y esta pantalla), todo el
// flujo de post-adjudicación (Contrato.tsx/PostAdjudicacion.tsx) y de
// autopsia del fallo (Autopsia.tsx) era inalcanzable de punta a punta.
import { fetchJson, postJson } from "./admin-client.ts";
import type { TenderStatus, TenderSummary } from "./tenders-client.ts";

export type TenderResolutionValue = "won" | "lost";

export interface TenderResolutionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly resolution: TenderResolutionValue;
  readonly fromStatus: TenderStatus;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
}

export async function fetchTenderResolutions(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly TenderResolutionRecord[]> {
  const body = await fetchJson<{ resolutions: readonly TenderResolutionRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/resolution`, token);
  return body.resolutions;
}

/** El servidor valida la transición en vivo (`checkTenderResolution`, tender-resolution.ts) -- este cliente nunca decide si es válida, solo propaga el 409 con el mensaje del servidor si no lo es. */
export async function resolveTender(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: { resolution: TenderResolutionValue; reason: string },
): Promise<TenderSummary> {
  return postJson<TenderSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/resolution`, token, input);
}
