// Rn-P3-08 -- pre-check-in publico por reserva. Tipos de dominio, sin IO.
//
// El huesped de una OTA (Airbnb, Booking, Vrbo) llega por iCal sin correo. Escribe su codigo de confirmacion y los ultimos 4 digitos de su
// telefono (ambos vienen del iCal, ver ical/parser.ts); si coinciden con una reserva confirmada y proxima de ESA property captura su correo
// (y WhatsApp opcional) y acepta el aviso de privacidad y el reglamento. La siguiente corrida de liberacion le entrega el acceso por correo.

/** 5 intentos fallidos con un mismo codigo bloquean ese codigo durante 1 hora (los aplica la base: rentas.precheckin_verificar). */
export const PRECHECKIN_MAX_FALLOS = 5;
export const PRECHECKIN_BLOQUEO_MINUTOS = 60;
/** Vigencia del token entre la verificacion y la captura (la fija la base). */
export const PRECHECKIN_TOKEN_MINUTOS = 15;

/**
 * Version del texto del aviso de privacidad que se muestra en el formulario y que queda guardada con la aceptacion. El texto legal definitivo
 * es una decision de Javier (ver docs/PRIVACIDAD-PLATAFORMA.md): al cambiarlo se sube la version.
 */
export const AVISO_PRECHECKIN_VERSION = "2026-10-v1";

/** Respuesta a la pantalla publica: lo unico que el huesped ve de la reserva (nunca nombres, montos ni el codigo de otros). */
export interface InfoPrecheckin {
  readonly propiedadNombre: string;
  readonly organizacionNombre: string;
  /** `null`: la property no pide aceptar reglamento. */
  readonly reglamento: string | null;
  readonly reglamentoVersion: number;
}

export interface VerificacionPrecheckinDb {
  readonly resultado: "ok" | "invalido" | "bloqueado";
  readonly propiedadNombre: string | null;
  readonly unidadNombre: string | null;
  readonly checkIn: string | null;
  readonly checkOut: string | null;
  readonly yaCapturado: boolean;
  readonly tokenExpiraEn: string | null;
}

export type ResultadoCapturaDb = "ok" | "token_invalido" | "privacidad_requerida" | "reglamento_requerido" | "ya_capturado";

export interface EntradaCapturaDb {
  readonly tokenHash: string;
  readonly correo: string;
  readonly whatsapp: string | null;
  readonly aceptaPrivacidad: boolean;
  readonly avisoVersion: string;
  readonly aceptaReglamento: boolean;
}

/** Operacion contra una base que puede no tener aun la migracion 036. */
export type ResultadoPrecheckin<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export interface ConfigPrecheckin {
  readonly propertyId: string;
  readonly reglamento: string | null;
  readonly reglamentoVersion: number;
}

export type ResultadoVerificar =
  | { readonly estado: "ok"; readonly token: string; readonly tokenExpiraEn: string; readonly propiedadNombre: string; readonly unidadNombre: string; readonly checkIn: string; readonly checkOut: string; readonly yaCapturado: boolean }
  | { readonly estado: "invalido" }
  | { readonly estado: "bloqueado" }
  | { readonly estado: "no_disponible" };

export type ResultadoCapturar = { readonly estado: ResultadoCapturaDb } | { readonly estado: "no_disponible" };
