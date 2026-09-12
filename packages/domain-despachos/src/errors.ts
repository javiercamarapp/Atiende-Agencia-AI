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

// ---- Cierre mensual (Fase 6) ----

/** Bloqueo de edición de movimientos ya cerrados — puerto del hallazgo de
 * auditoría de esta fase: NI `close_management` NI `monthly_close` del
 * origen Python implementan este bloqueo (verificado: cero referencias a
 * chequear el estado del período antes de escribir un movimiento/póliza en
 * todo el repo de referencia) — es una funcionalidad NUEVA de este port, no
 * una réplica de un comportamiento existente. Se usa en el punto de
 * integración real elegido para esta fase (ingesta de CFDI, ver
 * `cfdi.ts`). */
export class PeriodoCerradoError extends Error {
  constructor(periodo: string, contexto: string) {
    super(`El periodo ${periodo} ya está cerrado; no se puede ${contexto}. Reabra el periodo primero.`);
    this.name = "PeriodoCerradoError";
  }
}

export class PeriodoYaAbiertoError extends Error {
  constructor(message = "Ya existe un período abierto para ese año/mes.") {
    super(message);
    this.name = "PeriodoYaAbiertoError";
  }
}

export class CierreValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CierreValidacionError";
  }
}

export class TareaCierreEstadoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TareaCierreEstadoInvalidoError";
  }
}
