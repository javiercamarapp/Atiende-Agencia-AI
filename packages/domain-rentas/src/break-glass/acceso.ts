// El corazón del mecanismo: valida la razón obligatoria, ejecuta la lectura real, y
// garantiza que NUNCA se entregan datos al llamador sin que la fila de auditoría que
// los describe haya quedado persistida primero (fail-closed) -- ver
// BreakGlassAuditWriteFailedError para el porqué esto es deliberadamente distinto del
// "best-effort" de core-authz/impersonation/audit.ts::recordImpersonation.
import { BreakGlassAuditWriteFailedError, BreakGlassOrganizationRequiredError, BreakGlassReasonRequiredError } from "./errors.ts";
import { BREAK_GLASS_MIN_REASON_LENGTH } from "./tipos.ts";
import type {
  BreakGlassAccessInput,
  BreakGlassAuditEntry,
  BreakGlassFinanzasResumen,
  BreakGlassLectorPaginacion,
  BreakGlassLectorResultado,
  BreakGlassLimpiezaResumen,
  BreakGlassMensajeriaResumen,
  BreakGlassPayoutResumen,
  BreakGlassPricingResumen,
  BreakGlassReservaResumen,
  BreakGlassSyncIcalResumen,
} from "./tipos.ts";
import type { BreakGlassAuditRepository } from "./audit-repository.ts";
import type { BreakGlassRentasDataRepository } from "./data-repository.ts";

/** Extrae `{ propertyId, limit, offset }` de `resourceScope` (jsonb, viaja tal
 *  cual a la bitácora) -- compartido por `leerReservasTenantBreakGlass` y
 *  `crearLectorTenantBreakGlass` (Fase 10c) para que los 7 lectores de tenant
 *  acepten el mismo alcance opcional de filtro/paginado desde la misma forma de
 *  entrada, sin que cada composición reimplemente el chequeo de tipo. Cualquier
 *  valor con forma inesperada (no string/number) se ignora -- nunca lanza, el
 *  peor caso es "sin filtro/paginado explícito", nunca un 500. */
function extraerPaginacionDeResourceScope(resourceScope: BreakGlassAccessInput["resourceScope"]): BreakGlassLectorPaginacion {
  const propertyId = typeof resourceScope?.propertyId === "string" ? resourceScope.propertyId : undefined;
  const limit = typeof resourceScope?.limit === "number" && Number.isFinite(resourceScope.limit) ? resourceScope.limit : undefined;
  const offset = typeof resourceScope?.offset === "number" && Number.isFinite(resourceScope.offset) ? resourceScope.offset : undefined;
  return { propertyId, limit, offset };
}

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
 *
 * `data` es `BreakGlassLectorResultado<BreakGlassReservaResumen>` (UNIFICADO
 * con los 6 lectores de abajo desde la paginación real, hallazgo BAJA de la
 * auditoría a2 -- antes de eso era un array plano, un caso especial que la
 * ruta HTTP tenía que distinguir con `Array.isArray`). El resumen auditado
 * sigue siendo `{ total, ocupacionIds }` (nunca el genérico `{ total, ids }`
 * de `crearLectorTenantBreakGlass`, porque `BreakGlassReservaResumen` no
 * tiene un campo `id`) -- por eso esta composición sigue separada en vez de
 * reusar esa fábrica genérica.
 */
export async function leerReservasTenantBreakGlass(
  auditRepo: BreakGlassAuditRepository,
  dataRepo: BreakGlassRentasDataRepository,
  input: Omit<BreakGlassAccessInput, "resourceType">,
  nowMs: number = Date.now(),
): Promise<{ data: BreakGlassLectorResultado<BreakGlassReservaResumen>; auditEntry: BreakGlassAuditEntry }> {
  const paginacion = extraerPaginacionDeResourceScope(input.resourceScope);
  return leerDatosTenantBreakGlass(
    auditRepo,
    { ...input, resourceType: "reservas" },
    () => dataRepo.listReservasTenant(input.organizationId, input.actor.userId, paginacion),
    (resultado) => ({ total: resultado.datos.length, ocupacionIds: resultado.datos.map((r) => r.ocupacionId) }),
    nowMs,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectores restantes (Fase 10c -- ver tipos.ts y
// ../../migrations/020_break_glass_lectores.sql). `crearLectorTenantBreakGlass`
// factoriza EXACTAMENTE el mismo patrón de `leerReservasTenantBreakGlass` de
// arriba (validar entrada -> leer -> describir -> auditar -> fail-closed, vía
// `leerDatosTenantBreakGlass`) para los 6 tipos de recurso nuevos, que a
// diferencia de `BreakGlassReservaResumen` (auditado por `ocupacionIds`) todos
// comparten la misma forma de resumen mínimo (`{ total, ids }` sobre su propio
// campo `id`) -- evita repetir 6 veces el mismo cuerpo de función solo con el
// nombre del método del puerto y el `resourceType` distintos.
//
// FIX hallazgo de revisión real (ronda 1 del PR #155, bloqueante 3) -- estos 6
// lectores, a diferencia de `leerReservasTenantBreakGlass`, SÍ pueden estar
// "no disponibles" (`BreakGlassLectorResultado.disponible === false`, ver
// tipos.ts): la migración 020 todavía no aplicada en la base real. Ese caso NO
// pasa por `leerDatosTenantBreakGlass` -- nunca hubo una lectura real que
// describir ni auditar (el mandato de la bitácora es "qué datos exactos se
// vieron" de un uso COMPLETO del mecanismo, no un log de intentos fallidos, ver
// el comentario de cabecera de `leerDatosTenantBreakGlass`) -- se propaga el
// vacío honesto directo al llamador, con `auditEntry: null` explícito para que
// la ruta/la UI puedan distinguirlo de una lectura real con 0 filas.
// ─────────────────────────────────────────────────────────────────────────────
function crearLectorTenantBreakGlass<T extends { readonly id: string }>(
  resourceType: BreakGlassAccessInput["resourceType"],
  listar: (dataRepo: BreakGlassRentasDataRepository, organizationId: string, callerId: string, paginacion: BreakGlassLectorPaginacion) => Promise<BreakGlassLectorResultado<T>>,
) {
  return async function leer(
    auditRepo: BreakGlassAuditRepository,
    dataRepo: BreakGlassRentasDataRepository,
    input: Omit<BreakGlassAccessInput, "resourceType">,
    nowMs: number = Date.now(),
  ): Promise<{ data: BreakGlassLectorResultado<T>; auditEntry: BreakGlassAuditEntry | null }> {
    if (!input.organizationId) throw new BreakGlassOrganizationRequiredError();
    const reason = validarRazonBreakGlass(input.reason);
    const paginacion = extraerPaginacionDeResourceScope(input.resourceScope);

    const resultado = await listar(dataRepo, input.organizationId, input.actor.userId, paginacion);
    if (!resultado.disponible) {
      return { data: resultado, auditEntry: null };
    }

    let auditEntry: BreakGlassAuditEntry;
    try {
      auditEntry = await auditRepo.record({
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email ?? null,
        organizationId: input.organizationId,
        reason,
        resourceType,
        resourceScope: input.resourceScope ?? {},
        resultSummary: { total: resultado.datos.length, ids: resultado.datos.map((r) => r.id) },
        occurredAtMs: nowMs,
      });
    } catch (err) {
      throw new BreakGlassAuditWriteFailedError(err);
    }
    return { data: resultado, auditEntry };
  };
}

/** Composición concreta para `resourceType: "finanzas"` -- ver
 *  `BreakGlassRentasDataRepository.listFinanzasTenant`. */
export const leerFinanzasTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassFinanzasResumen>("finanzas", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listFinanzasTenant(organizationId, callerId, paginacion),
);

/** Composición concreta para `resourceType: "payouts"` -- ver
 *  `BreakGlassRentasDataRepository.listPayoutsTenant`. */
export const leerPayoutsTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassPayoutResumen>("payouts", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listPayoutsTenant(organizationId, callerId, paginacion),
);

/** Composición concreta para `resourceType: "pricing"` -- ver
 *  `BreakGlassRentasDataRepository.listPricingTenant`. */
export const leerPricingTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassPricingResumen>("pricing", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listPricingTenant(organizationId, callerId, paginacion),
);

/** Composición concreta para `resourceType: "mensajeria"` -- ver
 *  `BreakGlassRentasDataRepository.listMensajeriaTenant`. */
export const leerMensajeriaTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassMensajeriaResumen>("mensajeria", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listMensajeriaTenant(organizationId, callerId, paginacion),
);

/** Composición concreta para `resourceType: "limpieza"` -- cubre limpieza Y
 *  mantenimiento (ver `BreakGlassRentasDataRepository.listLimpiezaTenant`). */
export const leerLimpiezaTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassLimpiezaResumen>("limpieza", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listLimpiezaTenant(organizationId, callerId, paginacion),
);

/** Composición concreta para `resourceType: "sync_ical"` -- ver
 *  `BreakGlassRentasDataRepository.listSyncIcalTenant`. La URL de import ya
 *  llega enmascarada desde el propio repositorio (ver
 *  `BreakGlassSyncIcalResumen`), así que la bitácora nunca ve el valor completo. */
export const leerSyncIcalTenantBreakGlass = crearLectorTenantBreakGlass<BreakGlassSyncIcalResumen>("sync_ical", (dataRepo, organizationId, callerId, paginacion) =>
  dataRepo.listSyncIcalTenant(organizationId, callerId, paginacion),
);
