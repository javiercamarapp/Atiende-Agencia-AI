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

// ---- Contabilidad electrónica SAT — catálogo/balanza/paquete (cierre de gap
// "Motor de contabilidad electrónica SAT", ver
// `contabilidad-electronica/paquete.ts`) ----

/** Puerto de los `ValueError` que lanzan `marcar_timbrado`/`marcar_enviado`
 * del origen (`contabilidad_electronica.py`) al transicionar desde un
 * estado que no lo permite. `marcarListoParaTimbrar` en este puerto TAMBIÉN
 * valida (ver nota de fidelidad en `paquete.ts`: el original no valida esa
 * transición, se trata como un bug del origen, corregido y documentado —
 * mismo criterio ya establecido por `cierre-mensual/engine.ts::cerrarPeriodo`
 * para el bug análogo de re-cerrar un período `closed`). */
export class TransicionPaqueteContabilidadInvalidaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransicionPaqueteContabilidadInvalidaError";
  }
}

// ---- Cobranza (Fase 10) ----

/** Port del criterio de idempotencia de `InvoiceAlreadyExistsError`: un
 * mismo invoice nunca arranca el reloj de cobranza dos veces. */
export class ReceivableAlreadyExistsError extends Error {
  constructor(invoiceId: string) {
    super(`Ya existe una cuenta por cobrar registrada para el invoice "${invoiceId}".`);
    this.name = "ReceivableAlreadyExistsError";
  }
}

export class ReceivableAlreadyPaidError extends Error {
  constructor(message = "Esta cuenta por cobrar ya fue marcada como pagada.") {
    super(message);
    this.name = "ReceivableAlreadyPaidError";
  }
}

// ---- FASE 3 (producto) -- zona horaria por negocio (migración 012) ----

/** REGLA DURA de compatibilidad del repo: mergear a `main` despliega el código de
 * inmediato pero la base real va migraciones atrás. Si `despachos.property_config`
 * todavía no existe/no tiene el GRANT de escritura en la base real que atiende este
 * request, `upsertPropertyConfigZonaHoraria` lanza esto en vez de un 500 crudo de
 * Postgres -- la ruta HTTP lo traduce a un 503 honesto ("todavía no disponible"),
 * mismo criterio que `RestaurantesConfigUnavailableError` (domain-restaurantes,
 * leído primero como plantilla). */
export class DespachosConfigUnavailableError extends Error {
  constructor(message = "La configuración de zona horaria todavía no está disponible en esta base -- aplica la migración 012 (despachos.property_config).") {
    super(message);
    this.name = "DespachosConfigUnavailableError";
  }
}
