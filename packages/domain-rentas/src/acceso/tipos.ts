// Rn-04 -- liberación de instrucciones de acceso al huésped. Tipos de dominio, sin IO.
// La decisión de CUÁNDO liberar (ventana respecto del check-in en la zona de la property,
// reserva confirmada, pago según política) vive en una sola fuente: la función SQL
// rentas.acceso_siguiente_liberacion (migración 025), que resuelve la zona con la base
// de zonas de Postgres. Este paquete orquesta: entrega el correo y marca la liberación.

export type EventoBitacoraAcceso = "liberada" | "omitida_sin_contacto" | "omitida_sin_instrucciones" | "error_envio" | "entregada_manual" | "precheckin_capturado";
/** Eventos que la corrida de liberacion registra por su cuenta (sesion de sistema). Los otros dos los escriben el staff (entrega manual) y el pre-check-in publico. */
export type EventoOmitidoAcceso = "omitida_sin_contacto" | "omitida_sin_instrucciones" | "error_envio";

export interface PoliticaAcceso {
  readonly propertyId: string;
  readonly activo: boolean;
  /** 1..168 */
  readonly horasAntesCheckin: number;
  /** Hora local de check-in 'HH:MM' en la zona de la property. */
  readonly horaCheckin: string;
  readonly exigirPago: boolean;
  readonly otaCuentaComoPagada: boolean;
}

/** Política por defecto cuando la property no tiene fila: APAGADA (no se libera nada). */
export const POLITICA_ACCESO_POR_DEFECTO = { activo: false, horasAntesCheckin: 24, horaCheckin: "15:00", exigirPago: true, otaCuentaComoPagada: true } as const;

export interface InstruccionAcceso {
  readonly unidadId: string;
  readonly direccionExacta: string;
  readonly codigoAcceso: string | null;
  readonly instrucciones: string | null;
}

/** Reserva cuyas instrucciones toca liberar AHORA (ya filtrada por la base). Contiene el secreto. */
export interface LiberacionPendiente {
  readonly ocupacionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly unidadNombre: string;
  readonly tenantNombre: string;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
  readonly tieneInstrucciones: boolean;
  readonly direccionExacta: string | null;
  readonly codigoAcceso: string | null;
  readonly instrucciones: string | null;
  /** Rn-29: la base guarda solo el sobre cifrado y no se pudo abrir (sin llave, llave invalida o sobre no autenticable). Los campos de arriba vienen vacios. */
  readonly errorAcceso?: ErrorAccesoLiberacion;
}

export type ErrorAccesoLiberacion = "llave_no_configurada" | "llave_invalida" | "llave_version_no_disponible" | "no_descifrable";

export interface ResumenBarridoCifrado {
  /** `false`: la base aun no tiene la migracion 028 (el barrido no hizo nada). */
  readonly disponible: boolean;
  readonly cifradas: number;
  /** Filas que no se cifraron porque el ida y vuelta no coincidio (no se anula nada en claro). */
  readonly fallidas: number;
}

export interface EventoAccesoRecord {
  readonly id: string;
  readonly ocupacionId: string;
  readonly evento: EventoBitacoraAcceso;
  readonly canal: string | null;
  readonly creadoEn: string;
}

/** Reserva próxima (o en curso) con su estado de pago confirmado y de liberación, para el panel de staff. */
export interface ReservaAccesoRecord {
  readonly ocupacionId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly canal: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
  readonly pagoConfirmado: boolean;
  readonly liberada: boolean;
}

/** Rn-P3-09 -- reserva confirmada y proxima cuyo acceso se omitio por falta de correo del huesped y que nadie ha entregado todavia. */
export interface PendienteEntregaOta {
  readonly ocupacionId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly canal: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
  /** Ultima vez que la corrida la omitio (ISO). */
  readonly omitidaEn: string;
}

/** Datos de la reserva para armar el mensaje manual de acceso (sin el secreto: ese viene de `obtenerInstruccion`). */
export interface ReservaParaMensajeOta {
  readonly ocupacionId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
}

export type ResultadoEntregaManual = "entregada" | "ya_entregada" | "no_encontrada" | "no_disponible";

/** Resultado de una operación de staff contra una base que puede no tener aún la migración 025. */
export type ResultadoAcceso<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export type ResultadoConfirmarPago = "confirmado" | "revocado" | "no_encontrada" | "no_disponible";

export const HORAS_ANTES_MIN = 1;
export const HORAS_ANTES_MAX = 168;
