// Errores de dominio propios de domain-despachos — apps/api los mapea a códigos
// HTTP. Mismo patrón que domain-hoteles/src/errors.ts y domain-restaurantes/src/
// errors.ts: el vocabulario vive en el paquete de dominio, el mapeo a status HTTP
// vive en la ruta.
export class IdempotencyConflictError extends Error {
  constructor(message = "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class InvoiceAlreadyExistsError extends Error {
  constructor(folioFiscal: string) {
    super(`Ya existe un CFDI ingerido con folio fiscal (UUID) "${folioFiscal}" en esta organización.`);
    this.name = "InvoiceAlreadyExistsError";
  }
}

export class InvoiceReviewAlreadyResolvedError extends Error {
  constructor(message = "Esta revisión ya fue resuelta anteriormente.") {
    super(message);
    this.name = "InvoiceReviewAlreadyResolvedError";
  }
}
