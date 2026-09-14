// Fase 5 pieza 1 — `source_runs` (REQ-146/147/148/149). Port ADAPTADO de
// `licitaciones/packages/sources/src/pipeline/source-health.ts` +
// `http/response-classifier.ts` (clasificación de fallos) al modelo de
// tenancy por organización de Fusion (mismo criterio que el resto de
// domain-licitaciones: sin `SourceId` de plataforma, todo `organizationId`).
import { SOURCE_HEALTH_STATES, CaptchaDetectedError, InterfaceChangedError, SourceNotConfiguredError, type SourceConnectorId, type SourceHealthState } from "./connector-registry.ts";

export function isSourceHealthState(value: string): value is SourceHealthState {
  return (SOURCE_HEALTH_STATES as readonly string[]).includes(value);
}

/**
 * Evidencia de una corrida (REQ-147: "evidencia (respuesta cruda/hash) y
 * cobertura (esperado vs. obtenido)"). `coverage` es OBLIGATORIO cuando
 * `state === "ok"` -- una corrida "ok" sin cobertura declarada sería
 * indistinguible del antipatrón que REQ-148 prohíbe ("0 resultados" mudo).
 */
export interface SourceRunEvidence {
  readonly httpStatus?: number;
  readonly responseHash?: string;
  readonly message: string;
  readonly coverage?: { readonly expected: number; readonly obtained: number };
}

export interface SourceRunInput {
  readonly source: SourceConnectorId;
  readonly state: SourceHealthState;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly evidence: SourceRunEvidence;
  /** Reutiliza el mismo `correlationId` de la operación que disparó la corrida (p. ej. el alta manual), para reconstruir la traza completa vía `audit_log`/`X-Correlation-Id` -- mismo criterio que REQ-171 en el repo origen. */
  readonly correlationId: string | null;
}

export interface SourceRunRecord extends SourceRunInput {
  readonly id: string;
  readonly organizationId: string;
  readonly createdAt: string;
}

/**
 * Frescura de una fuente (REQ-149: "cada fuente ... muestra la edad del
 * último dato exitoso y un umbral de obsolescencia configurable; la
 * obsolescencia se muestra al usuario, nunca se oculta"). `lastSuccessAt ===
 * null` significa "nunca hubo una corrida exitosa" -- se reporta como
 * `stale: true` explícitamente, nunca como "0 de antigüedad" (que se leería
 * como "recién actualizado").
 */
export interface SourceFreshnessRecord {
  readonly source: SourceConnectorId;
  readonly lastRunState: SourceHealthState | null;
  readonly lastSuccessAt: string | null;
  readonly staleForMs: number | null;
  readonly staleThresholdMs: number;
  readonly stale: boolean;
}

/**
 * Umbral de obsolescencia por fuente (REQ-149: "configurable"), en
 * milisegundos. Por defecto, 3x la cadencia declarada del conector (ver
 * `connector-registry.ts`) redondeado a un valor legible -- una fuente que
 * lleva sin éxito más de 3 ciclos de su propia cadencia se considera
 * obsoleta. "manual" no tiene cadencia automática, así que usa un umbral fijo
 * orientado a operación humana (7 días: una convocatoria que nadie
 * actualiza en una semana amerita revisión).
 */
export const DEFAULT_STALE_THRESHOLD_MS: Record<SourceConnectorId, number> = {
  manual: 7 * 24 * 60 * 60_000,
  comprasmx: 3 * 30 * 60_000,
  dof: 3 * 60 * 60_000,
  ocds_shcp: 3 * 15 * 60_000,
  pdn_s6: 3 * 15 * 60_000,
  state_portal: 3 * 60 * 60_000,
  // Fase 8 — 3x su propia cadencia declarada (24 h, ver connector-registry.ts), mismo criterio que el resto de esta tabla.
  compras_mx_historico: 3 * 24 * 60 * 60_000,
};

/**
 * Clasifica un error en un `SourceHealthState` explícito (REQ-148). Port
 * adaptado de `classifySourceFailure` del origen -- sin los tipos de
 * transporte HTTP propios del origen (`HttpError`/`HostPausedError`/
 * `ZodError`), que Fusion no porta en esta fase; cualquier conector real
 * futuro que SÍ los use puede extender esta función igual que el origen
 * extendía la suya, sin romper los casos ya cubiertos.
 */
export function classifySourceFailure(error: unknown): { state: SourceHealthState; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SourceNotConfiguredError) return { state: "not_configured", message };
  if (error instanceof CaptchaDetectedError) return { state: "captcha_detected", message };
  if (error instanceof InterfaceChangedError) return { state: "interface_changed", message };
  if (/captcha/i.test(message)) return { state: "captcha_detected", message };
  return { state: "down", message };
}

export function computeStaleForMs(lastSuccessAt: string | null, now: Date): number | null {
  if (lastSuccessAt === null) return null;
  return Math.max(0, now.getTime() - new Date(lastSuccessAt).getTime());
}

/**
 * Deriva un `SourceFreshnessRecord` a partir de la última corrida CONOCIDA
 * (o `null`/`undefined` si nunca hubo ninguna) -- pura, para que
 * `PostgresLicitacionesRepository.sourceFreshness`/`InMemoryLicitacionesRepository.sourceFreshness`
 * no dupliquen este cálculo cada uno a su manera.
 */
export function evaluateSourceFreshness(
  source: SourceConnectorId,
  lastSuccessfulRun: { state: SourceHealthState; finishedAt: string } | null | undefined,
  lastRunOfAnyState: { state: SourceHealthState } | null | undefined,
  now: Date,
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS[source],
): SourceFreshnessRecord {
  const lastSuccessAt = lastSuccessfulRun?.finishedAt ?? null;
  const staleForMs = computeStaleForMs(lastSuccessAt, now);
  return {
    source,
    lastRunState: lastRunOfAnyState?.state ?? lastSuccessfulRun?.state ?? null,
    lastSuccessAt,
    staleForMs,
    staleThresholdMs,
    // Nunca hubo éxito -> obsoleto por definición (REQ-149: nunca se oculta).
    stale: staleForMs === null ? true : staleForMs > staleThresholdMs,
  };
}
