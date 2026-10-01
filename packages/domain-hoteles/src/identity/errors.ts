// Errores de dominio de la boveda de identidad (H-01). Los adaptadores traducen los
// SQLSTATE/mensajes de migrations/031_hoteles_boveda_identidad.sql a estos tipos para
// que las rutas HTTP respondan 403/404/409/422/503 y nunca un 500 crudo.

/** La boveda no se puede usar en esta base/entorno: migracion 031 sin aplicar
 *  (42883/42P01/42703) o llave de cifrado no configurada. Las rutas responden 503. */
export class IdentityUnavailableError extends Error {
  constructor(readonly reason: "migracion_pendiente" | "llave_no_configurada" | "llave_version_no_disponible", operation: string) {
    super(
      reason === "migracion_pendiente"
        ? `La boveda de identidad aun no esta disponible en esta base (migracion pendiente) -- operacion: ${operation}.`
        : reason === "llave_no_configurada"
          ? `La boveda de identidad no esta configurada: falta la llave de cifrado (HOTELES_IDENTITY_KEY) -- operacion: ${operation}.`
          : `La llave de cifrado de la version guardada no esta disponible en este entorno -- operacion: ${operation}.`,
    );
    this.name = "IdentityUnavailableError";
  }
}

/** La base (RLS/funcion) nego la operacion: rol sin permiso, cross-tenant o id que el
 *  llamador no puede ver (mismo error para no servir de oraculo de existencia). */
export class IdentityAccessDeniedError extends Error {
  constructor(operation: string) {
    super(`Sin permiso para esta operacion de identidad (${operation}) o el registro no existe.`);
    this.name = "IdentityAccessDeniedError";
  }
}

/** Doble control: quien solicito la purga no puede decidirla. */
export class IdentityDoubleControlError extends Error {
  constructor() {
    super("Doble control: quien solicita la purga no puede aprobarla ni rechazarla; debe decidirla otra persona con rol owner/gm.");
    this.name = "IdentityDoubleControlError";
  }
}

export class IdentityPurgedError extends Error {
  constructor() {
    super("La identidad ya fue purgada y no se puede consultar ni modificar.");
    this.name = "IdentityPurgedError";
  }
}

export class IdentityRequestResolvedError extends Error {
  constructor() {
    super("La solicitud de purga ya fue resuelta.");
    this.name = "IdentityRequestResolvedError";
  }
}

/** Unicidad: ya hay una solicitud pendiente para esa identidad, o ya existe el registro migratorio. */
export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityConflictError";
  }
}

/** Entrada que la base rechazo por contenido (motivo invalido, huesped/reserva de otra property...). */
export class IdentityInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityInvalidInputError";
  }
}

/** No se pudo descifrar el sobre (llave equivocada, sobre alterado o ligado a otra fila). */
export class IdentityDecryptError extends Error {
  constructor() {
    super("No se pudo descifrar la identidad: sobre alterado, llave incorrecta o ligado a otro registro.");
    this.name = "IdentityDecryptError";
  }
}
