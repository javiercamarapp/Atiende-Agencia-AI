// Cliente web de fuentes y frescura (L-03) -- consume las tres lecturas que ya
// expone sources.ts: GET .../sources (registro de conectores), GET
// .../sources/freshness (frescura por fuente, REQ-149) y GET .../sources/runs
// (corridas recientes con evidencia, REQ-147). Todas son de solo lectura:
// ningun cliente puede insertar una corrida a mano.
//
// Mismo aislamiento que el resto de lib/*-client.ts: no depende de
// @atiende/domain-licitaciones, los tipos son espejos literales del contrato.
import { fetchJson } from "./admin-client.ts";

export type SourceHealthState = "ok" | "down" | "captcha_detected" | "interface_changed" | "permission_missing" | "rate_limited" | "not_configured";

/** Espejo de `SourceConnectorDescriptor` sin la funcion `connector` (no viaja por JSON). */
export interface SourceConnectorInfo {
  readonly id: string;
  readonly kind: "manual" | "automated";
  readonly label: string;
  readonly termsNote: string;
  readonly cadence: { readonly minIntervalMinutes: number; readonly note: string };
  readonly liveVerification: { readonly verified: boolean; readonly note: string };
}

/** Espejo de `SourceFreshnessRecord` (domain-licitaciones/source-run.ts). */
export interface SourceFreshness {
  readonly source: string;
  readonly lastRunState: SourceHealthState | null;
  readonly lastSuccessAt: string | null;
  readonly staleForMs: number | null;
  readonly staleThresholdMs: number;
  readonly stale: boolean;
}

/** Espejo de `SourceRunRecord`. */
export interface SourceRun {
  readonly id: string;
  readonly source: string;
  readonly state: SourceHealthState;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly evidence: {
    readonly httpStatus?: number;
    readonly message: string;
    readonly coverage?: { readonly expected: number; readonly obtained: number };
  };
  readonly notPersistedReason?: string;
}

export async function fetchSourceConnectors(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly SourceConnectorInfo[]> {
  const body = await fetchJson<{ connectors: readonly SourceConnectorInfo[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/sources`, token);
  return body.connectors;
}

export async function fetchSourceFreshness(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly SourceFreshness[]> {
  const body = await fetchJson<{ freshness: readonly SourceFreshness[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/sources/freshness`, token);
  return body.freshness;
}

export async function fetchSourceRuns(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opts: { source?: string; limit?: number } = {}): Promise<readonly SourceRun[]> {
  const qs = new URLSearchParams();
  if (opts.source) qs.set("source", opts.source);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  const body = await fetchJson<{ runs: readonly SourceRun[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/sources/runs${suffix}`, token);
  return body.runs;
}

/** Texto en espanol para cada estado de salud (REQ-148: una falla nunca se muestra como "0 resultados"). */
export const SOURCE_STATE_LABELS: Record<SourceHealthState, string> = {
  ok: "Operando",
  down: "Caída",
  captcha_detected: "Bloqueada por captcha",
  interface_changed: "Cambió la interfaz",
  permission_missing: "Sin permiso de acceso",
  rate_limited: "Límite de peticiones",
  not_configured: "Sin configurar",
};

/** Antiguedad legible ("2 h", "3 d") a partir de milisegundos -- null cuando nunca hubo una corrida exitosa. */
export function formatAge(ms: number | null): string {
  if (ms === null) return "Nunca";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Hace menos de 1 min";
  if (min < 60) return `Hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `Hace ${h} h`;
  return `Hace ${Math.floor(h / 24)} d`;
}
