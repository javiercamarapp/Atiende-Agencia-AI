// Errores de dominio propios de domain-hoteles — apps/api los mapea a códigos HTTP
// (mismo patrón que domain-restaurantes/src/errors.ts: el vocabulario vive en el
// paquete de dominio, el mapeo a status HTTP vive en la ruta).
export class IdempotencyConflictError extends Error {
  constructor(message = "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}
