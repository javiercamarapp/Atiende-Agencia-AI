// El corazón del mecanismo: valida la razón obligatoria, ejecuta la lectura real, y
// garantiza que NUNCA se entregan datos al llamador sin que la fila de auditoría que
// los describe haya quedado persistida primero (fail-closed) -- ver
// BreakGlassAuditWriteFailedError para el porqué esto es deliberadamente distinto del
// "best-effort" de core-authz/impersonation/audit.ts::recordImpersonation.
import { BreakGlassAuditWriteFailedError, BreakGlassOrganizationRequiredError, BreakGlassReasonRequiredError } from "./errors.ts";
import { BREAK_GLASS_MIN_REASON_LENGTH } from "./tipos.ts";
import type { BreakGlassAccessInput, BreakGlassAuditEntry, BreakGlassReservaResumen } from "./tipos.ts";
import type { BreakGlassAuditRepository } from "./audit-repository.ts";
import type { BreakGlassRentasDataRepository } from "./data-repository.ts";

/**
 * Valida la razón obligatoria de un acceso de romper-cristal. Devuelve la razón ya
 * `trim()`eada (lo que de verdad se persiste -- nunca espacios de sobra contando para
 * el mínimo). Lanza `BreakGlassReasonRequiredError` si, tras `trim()`, no alcanza
 * `BREAK_GLASS_MIN_REASON_LENGTH`.
 */
export function validarRazonBreakGlass(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < BREAK_GLASS_MIN_REASON_LENGTH) {
    throw new BreakGlassReasonRequiredError(trimmed.length, BREAK_GLASS_MIN_REASON_LENGTH);
  }
  return trimmed;
}

/**
 * Orquestador genérico: valida entrada -> ejecuta `lector()` (la lectura real, ya
 * resuelta por el llamador contra el repositorio concreto que corresponda) ->
 * construye el resumen de resultado con `describirResultado(data)` -> persiste LA
 * bitácora -> solo entonces devuelve `data`.
 *
 * CONTRATO FAIL-CLOSED: si `auditRepo.record` lanza, esta función envuelve el error en
 * `BreakGlassAuditWriteFailedError` y lo relanza -- `data` (ya leído en memoria de este
 * proceso) NUNCA llega al llamador. Es la garantía central del gap ("SIEMPRE queda un
 * registro de auditoría inmutable... de qué datos exactos se vieron") expresada como
 * invariante de función, no como una convención que el llamador podría olvidar
 * respetar.
 *
 * Si `lector()` mismo lanza (la lectura real falló antes de producir datos), el error
 * se propaga tal cual -- no hay nada que auditar todavía, ni una fila "intento fallido"
 * que insertar (ver cabecera de 012_break_glass_audit.sql: cada fila es UN uso
 * COMPLETO del mecanismo, no un log de intentos).
 */
export async function leerDatosTenantBreakGlass<T>(
  auditRepo: BreakGlassAuditRepository,
  input: BreakGlassAccessInput,
  lector: () => Promise<T>,
  describirResultado: (data: T) => Readonly<Record<string, unknown>>,
  nowMs: number = Date.now(),
): Promise<{ data: T; auditEntry: BreakGlassAuditEntry }> {
  if (!input.organizationId) throw new BreakGlassOrganizationRequiredError();
  const reason = validarRazonBreakGlass(input.reason);

  const data = await lector();
  const resultSummary = describirResultado(data);

  let auditEntry: BreakGlassAuditEntry;
  try {
    auditEntry = await auditRepo.record({
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email ?? null,
      organizationId: input.organizationId,
      reason,
      resourceType: input.resourceType,
      resourceScope: input.resourceScope ?? {},
      resultSummary,
      occurredAtMs: nowMs,
    });
  } catch (err) {
    throw new BreakGlassAuditWriteFailedError(err);
  }

  return { data, auditEntry };
}

/**
 * Composición concreta para `resourceType: "reservas"`: lee todas las reservas del
 * tenant vía `dataRepo.listReservasTenant` y audita el resultado con los ids de
 * ocupación exactos que se devolvieron (más el conteo) -- "qué datos exactos se
 * vieron" en su forma más literal para esta categoría.
 */
export async function leerReservasTenantBreakGlass(
  auditRepo: BreakGlassAuditRepository,
  dataRepo: BreakGlassRentasDataRepository,
  input: Omit<BreakGlassAccessInput, "resourceType">,
  nowMs: number = Date.now(),
): Promise<{ data: readonly BreakGlassReservaResumen[]; auditEntry: BreakGlassAuditEntry }> {
  return leerDatosTenantBreakGlass(
    auditRepo,
    { ...input, resourceType: "reservas" },
    () => dataRepo.listReservasTenant(input.organizationId, input.actor.userId),
    (data) => ({ total: data.length, ocupacionIds: data.map((r) => r.ocupacionId) }),
    nowMs,
  );
}
