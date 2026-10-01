// Errores de dominio de privacidad (H-02). Los adaptadores traducen los SQLSTATE/mensajes de
// migrations/032_hoteles_consentimiento_arco_incidentes.sql para que las rutas HTTP respondan
// 403/404/409/422/503 y nunca un 500 crudo.

/** La migracion 032 no esta aplicada (42883/42P01/42703): las rutas responden 503 / "no disponible aun". */
export class PrivacyUnavailableError extends Error {
  constructor(operation: string) {
    super(`El modulo de privacidad aun no esta disponible en esta base (migracion 032 pendiente) -- operacion: ${operation}.`);
    this.name = "PrivacyUnavailableError";
  }
}

/** La base (RLS/funcion) nego la operacion: rol sin permiso, cross-tenant o id que el llamador no ve. */
export class PrivacyAccessDeniedError extends Error {
  constructor(operation: string) {
    super(`Sin permiso para esta operacion de privacidad (${operation}) o el registro no existe.`);
    this.name = "PrivacyAccessDeniedError";
  }
}

/** Doble control: quien solicita no puede decidir. */
export class PrivacyDoubleControlError extends Error {
  constructor() {
    super("Doble control: quien solicita el acceso excepcional no puede aprobarlo ni rechazarlo; debe decidirlo otra persona con rol owner/gm.");
    this.name = "PrivacyDoubleControlError";
  }
}

/** Estado no valido para la accion (ya resuelta, prorroga agotada, retencion ya liberada...) o unicidad. */
export class PrivacyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyConflictError";
  }
}

/** Entrada que la base o el dominio rechazan por contenido. */
export class PrivacyInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyInvalidInputError";
  }
}
