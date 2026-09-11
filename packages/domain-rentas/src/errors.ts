// Vocabulario de errores tipado propio de domain-rentas — mismo patrón que
// domain-hoteles::QuoteError: el paquete de dominio lanza un error CON CÓDIGO, apps/api
// lo traduce a un status HTTP en la ruta (ver diseño Fase 1 §4.1, "traducción de
// errores: mismo mapeo que traducirErrorDominio del origen"). El port original de
// aplicacion/reservas.ts usaba `throw new Error(string)` genérico; aquí se tipa para
// que la ruta HTTP pueda distinguir el código sin parsear el mensaje.
export type RentasErrorCode =
  | "rango_invalido"
  | "duracion_minima_no_alcanzada"
  | "unidad_no_encontrada"
  | "ocupacion_no_encontrada"
  | "reserva_no_directa"
  | "transicion_no_permitida";

export class RentasDomainError extends Error {
  readonly code: RentasErrorCode;

  constructor(code: RentasErrorCode, message: string) {
    super(message);
    this.name = "RentasDomainError";
    this.code = code;
  }
}
