// Errores de dominio propios de domain-licitaciones — apps/api los mapea a
// códigos HTTP (mismo patrón que domain-hoteles/src/errors.ts): el vocabulario
// vive en el paquete de dominio, el mapeo a status HTTP vive en la ruta.
export class IdempotencyConflictError extends Error {
  constructor(message = "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * AE-01 (ver dates.ts::resolveExpedienteAsOfIso): la convocatoria todavía no
 * tiene `submissionDeadline` fijado, así que no se puede evaluar de forma
 * segura la vigencia de tarifas/documentos de empresa a la fecha del acto.
 * Nunca se usa "ahora" como aproximación — se bloquea explícitamente.
 */
export class SubmissionDeadlineUnknownError extends Error {
  constructor(message = 'Esta convocatoria no tiene "submissionDeadline" fijado: no se puede evaluar de forma segura la vigencia de tarifas/documentos a la fecha del acto. Declare la fecha límite de presentación antes de continuar.') {
    super(message);
    this.name = "SubmissionDeadlineUnknownError";
  }
}

/**
 * AE-14 (ver diseño Fase 1 §4.3): el manifiesto guardado como "ready" ya no
 * refleja el estado vivo del expediente (una aprobación se invalidó, o el
 * checklist dejó de estar en verde) — nunca se sirve el ZIP viejo como si
 * siguiera vigente.
 */
export class ReadinessStaleError extends Error {
  constructor(
    readonly draftReasons: readonly string[],
    readonly missing: readonly string[],
    message = "El paquete generado quedó desactualizado (la aprobación vigente ya no cubre el estado actual del expediente, o el checklist dejó de estar en verde). Vuelve a ejecutar POST /package/assemble.",
  ) {
    super(message);
    this.name = "ReadinessStaleError";
  }
}

/**
 * Fase 2 pieza 1 (AE-02/AE-11, ver approval-workflow.ts): lanzado por
 * `ApprovalWorkflow.approve()`/`requestReview()` cuando la regla de
 * aprobación rechaza la operación -- rol no autorizado, `scope`/`scopeRef`
 * inconsistentes (AE-02), o autoaprobación (por haber enviado a revisión, o
 * por ser autor de contenido de una sección cubierta, AE-11). `reasonCode`
 * es estable y legible por máquina (apps/api lo mapea a un código HTTP
 * específico); `message` es el texto legible para humanos.
 */
export class ApprovalRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalRejectedError";
  }
}

/**
 * Fase 3 §7: lanzado por `buildGoNoGoDecision()` (go-no-go.ts) cuando la
 * regla de decisión rechaza la operación -- rol insuficiente (writer/viewer,
 * o cualquier rol fuera de GO_NO_GO_ROLES) o motivo vacío. `reasonCode` es
 * estable y legible por máquina (apps/api lo mapea a un código HTTP
 * específico, mismo patrón que `ApprovalRejectedError`).
 */
export class GoNoGoRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "GoNoGoRejectedError";
  }
}

/**
 * Fase 6 (REQ-051, ver contract-lifecycle.ts): lanzado por
 * `LicitacionesRepository.transitionContract()` cuando `toStatus` no es una
 * transición válida desde el `fromStatus` actual del contrato --
 * `allowedNextStates` (posiblemente vacío, estado terminal) va en la
 * respuesta HTTP (409) para que el cliente sepa exactamente qué transiciones
 * sí son válidas, sin adivinar.
 */
export class ContractTransitionRejectedError extends Error {
  constructor(
    readonly fromStatus: string,
    readonly toStatus: string,
    readonly allowedNextStates: readonly string[],
  ) {
    super(
      `Transición inválida: "${fromStatus}" -> "${toStatus}". Estados permitidos desde "${fromStatus}": ${allowedNextStates.length > 0 ? allowedNextStates.join(", ") : "(ninguno; estado terminal)"}.`,
    );
    this.name = "ContractTransitionRejectedError";
  }
}

/**
 * Fase 16 (post-adjudicación, pieza 0, ver tender-resolution.ts): lanzado por
 * `LicitacionesRepository.resolveTender()` cuando el `fromStatus` actual de
 * la convocatoria no está en `TENDER_RESOLVABLE_FROM_STATUSES` -- mismo
 * criterio exacto que `ContractTransitionRejectedError`, sin fusionarse con
 * ella porque el catálogo de estados de una convocatoria (`TenderStatus`) y
 * el de un contrato (`ContractStatus`) son dominios distintos.
 */
export class TenderResolutionRejectedError extends Error {
  constructor(
    readonly fromStatus: string,
    readonly resolution: string,
    readonly allowedFromStatuses: readonly string[],
  ) {
    super(
      `No se puede marcar la convocatoria como "${resolution}" desde el estado "${fromStatus}". Se requiere que ya haya pasado por una decisión "go" real (estados permitidos para resolver: ${allowedFromStatuses.join(", ")}).`,
    );
    this.name = "TenderResolutionRejectedError";
  }
}

/**
 * Fase 16 (company data escribible): lanzado al crear un dato de empresa con
 * clave natural duplicada (`concept` de una tarifa aprobada, `name` de una
 * capacidad, `role` de un firmante) -- las tres tablas tienen un índice único
 * (organization_id, <clave>) desde su migración original (001/009); crear un
 * duplicado nunca actualiza en silencio, el llamador usa el endpoint de
 * actualización (`PATCH .../:id`) explícitamente.
 */
export class CompanyDataDuplicateKeyError extends Error {
  constructor(
    readonly resource: string,
    readonly key: string,
  ) {
    super(`Ya existe un registro de "${resource}" con la clave "${key}" para esta organización. Use PATCH .../:id para actualizarlo en vez de crear uno nuevo.`);
    this.name = "CompanyDataDuplicateKeyError";
  }
}

/**
 * Fase 16 (company data escribible) -- hallazgo de auditoría: lanzado por
 * `LicitacionesRepository.updateCompanyDocument`/`updateApprovedRate`/
 * `updateCompanyCapability`/`updateCompanyExperience`/`updateCompanySigner`
 * cuando el `id` recibido no corresponde a ningún registro de la
 * organización (ya sea porque nunca existió o porque es de otra
 * organización -- ambos casos son indistinguibles desde afuera, mismo
 * criterio que el resto del vertical). Antes de este tipo, esos 5 métodos
 * lanzaban un `Error` genérico que `companyData.ts::mapDuplicateOrThrow`
 * capturaba con `catch (err) { ... err instanceof Error ... }` -- una red
 * tan amplia que CUALQUIER falla no reconocida (p. ej. "permission denied
 * for table ..." de Postgres por un GRANT faltante, o un `id` con formato de
 * UUID inválido) se reportaba igual como 404 con el mensaje crudo de la base
 * de datos filtrado tal cual al cliente. Con este tipo, `mapDuplicateOrThrow`
 * distingue "no encontrado" (404, mensaje propio) de cualquier otro error
 * (propagado sin envolver, para que `apps/api/src/app.ts::onError` lo trate
 * como 500 genérico sin filtrar el mensaje interno).
 */
export class CompanyDataNotFoundError extends Error {
  constructor(
    readonly resource: string,
    readonly id: string,
  ) {
    super(`${resource} "${id}" no encontrado(a) para esta organización.`);
    this.name = "CompanyDataNotFoundError";
  }
}
