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

/** Fase 10 — motor de recomendaciones de tarifa v1: una ESCRITURA de sistema
 *  (insertar/aplicar/expirar una recomendación, o configurar pricing_rule/
 *  local_event/competitor_rate) contra una base cuya migración 029 aún no está
 *  aplicada (42883/42P01/42703). A diferencia de las LECTURAS (que degradan a un
 *  vacío honesto sin lanzar, ver `postgres-repository.ts`), una escritura no tiene
 *  ningún "camino anterior" al que caer -- el motor de tarifas simplemente no
 *  existía antes de esta fase. La ruta HTTP mapea esto a 503, nunca a un 500 crudo
 *  ni a fingir que la escritura ocurrió. */
export class RateEngineUnavailableError extends Error {
  constructor(operation: string) {
    super(`El motor de recomendaciones de tarifa aún no está disponible en esta base (migración pendiente) -- operación: ${operation}.`);
    this.name = "RateEngineUnavailableError";
  }
}

/** FASE 3 (producto) zona horaria por negocio: una ESCRITURA de
 *  `hoteles.property_config` (configurar la zona horaria de una property) contra una
 *  base cuya migración 030 aún no está aplicada (42883/42P01/42703). Mismo criterio
 *  que `RateEngineUnavailableError` -- una escritura no tiene ningún "camino
 *  anterior" al que caer (la tabla simplemente no existía antes de esta fase); la
 *  LECTURA (`findPropertyTimezone`) sí degrada honesto a `null`, ver
 *  `postgres-repository.ts`. La ruta HTTP mapea esto a 503, nunca a un 500 crudo. */
export class PropertyConfigUnavailableError extends Error {
  constructor(operation: string) {
    super(`La configuración de property (zona horaria) aún no está disponible en esta base (migración pendiente) -- operación: ${operation}.`);
    this.name = "PropertyConfigUnavailableError";
  }
}

/** H-P3-01 -- el folio ya esta cerrado: un cargo/pago nuevo, o un segundo cierre, llego despues (o a la vez) que el
 *  cierre que lo gano. Lo lanzan los repositorios (el trigger de la migracion 045 en Postgres; la misma regla en el
 *  espejo en memoria) y la ruta de folios lo traduce a 409 en UN solo lugar. */
export class FolioCerradoError extends Error {
  constructor(message = "El folio ya está cerrado.") {
    super(message);
    this.name = "FolioCerradoError";
  }
}

/** H-P3-01 -- el cierre 'saldo_cero' llego con un saldo distinto de cero (un cargo o pago entro entre la lectura de la
 *  app y el UPDATE). Mismo criterio que `FolioCerradoError`: la ruta lo traduce a 409. */
export class FolioCierreSaldoError extends Error {
  constructor(message = "El saldo del folio cambió y ya no es cero: revisa el folio antes de cerrarlo.") {
    super(message);
    this.name = "FolioCierreSaldoError";
  }
}

/** Traduce un error crudo de Postgres de los triggers de la migracion 045 a su error de dominio; `null` si el error
 *  no viene de ellos (el llamador lo relanza tal cual). */
export function translateFolioTriggerError(err: unknown): FolioCerradoError | FolioCierreSaldoError | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e.message !== "string") return null;
  if (e.code !== "P0001") return null;
  if (e.message.startsWith("folio_cerrado")) return new FolioCerradoError("El folio está cerrado: no admite nuevos movimientos.");
  if (e.message.startsWith("cierre_saldo_distinto_de_cero")) return new FolioCierreSaldoError();
  return null;
}

/** H-P3-04 -- una ESCRITURA de configuracion del hotel (impuestos, politica de cancelacion, sobreventa, tarifa) contra una base cuya
 *  migracion 047 aun no esta aplicada (42883/42P01/42703). La LECTURA degrada a los valores por omision; una escritura no tiene camino
 *  anterior. La ruta HTTP la mapea a 503, nunca a un 500 crudo. */
export class HotelConfigUnavailableError extends Error {
  constructor(operation: string) {
    super(`La configuración del hotel aún no está disponible en esta base (migración pendiente) -- operación: ${operation}.`);
    this.name = "HotelConfigUnavailableError";
  }
}
