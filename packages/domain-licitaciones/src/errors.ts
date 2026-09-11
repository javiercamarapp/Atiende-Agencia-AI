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
