// Errores de dominio propios de domain-hoteles — apps/api los mapea a códigos HTTP
// (mismo patrón que domain-restaurantes/src/errors.ts: el vocabulario vive en el
// paquete de dominio, el mapeo a status HTTP vive en la ruta).
export class IdempotencyConflictError extends Error {
  constructor(message = "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/** H16-014/REQ-REC-014 (Fase 5) — una alerta de fraude ya resuelta (confirmada o
 *  descartada) no puede resolverse de nuevo. Mismo criterio que
 *  `InvoiceReviewAlreadyResolvedError` de domain-despachos para su cola de revisión. */
export class FraudAlertAlreadyResolvedError extends Error {
  constructor(message = "Esta alerta de fraude ya fue resuelta anteriormente.") {
    super(message);
    this.name = "FraudAlertAlreadyResolvedError";
  }
}

/** Fase 11/13 (REQ-CRM-002/003) — una acción de reputación ya resuelta (ejecutada o
 *  descartada) no puede resolverse de nuevo. Mismo criterio exacto que
 *  `FraudAlertAlreadyResolvedError`. */
export class GuestReviewActionAlreadyResolvedError extends Error {
  constructor(message = "Esta acción de reputación ya fue resuelta anteriormente.") {
    super(message);
    this.name = "GuestReviewActionAlreadyResolvedError";
  }
}
