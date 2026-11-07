// Rn-04 -- puerto de datos de la liberación de acceso. Separado de RentasRepository a
// propósito (mismo criterio que RentasCalendarSyncRepository): tablas nuevas de la
// migración 025, que pueden no existir todavía en la base real.
import type { EntradaInstruccion, EntradaPolitica } from "./validacion.ts";
import type { EventoAccesoRecord, ReservaAccesoRecord, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PendienteEntregaOta, PoliticaAcceso, ReservaParaMensajeOta, ResultadoAcceso, ResultadoConfirmarPago, ResultadoEntregaManual, ResumenBarridoCifrado } from "./tipos.ts";

export interface RentasAccesoRepository {
  // ---- staff (sesión del request, RLS real) ----
  /** `null` valor = la property no tiene política (equivale a APAGADA). */
  obtenerPolitica(propertyId: string): Promise<ResultadoAcceso<PoliticaAcceso | null>>;
  guardarPolitica(organizationId: string, propertyId: string, entrada: EntradaPolitica, actorId: string): Promise<ResultadoAcceso<PoliticaAcceso>>;
  /** Descifra y registra la lectura en la bitacora. Lanza `AccesoNoDisponibleError` sin llave valida (la ruta responde 503). */
  obtenerInstruccion(propertyId: string, unidadId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>>;
  /** Cifra antes de guardar (nunca texto plano) y registra la escritura. `valor: null` si la unidad no pertenece a la property. Lanza `AccesoNoDisponibleError` sin llave valida. */
  guardarInstruccion(organizationId: string, propertyId: string, unidadId: string, entrada: EntradaInstruccion, actorId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>>;
  confirmarPago(ocupacionId: string, confirmado: boolean): Promise<ResultadoConfirmarPago>;
  listarBitacora(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly EventoAccesoRecord[]>>;
  /** Reservas confirmadas con check-out de hoy en adelante (día de negocio de la property), con su estado de pago y liberación. */
  listarReservasProximas(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly ReservaAccesoRecord[]>>;
  /** Rn-P3-09: reservas proximas con acceso omitido por falta de correo y sin entregar (ni por correo ni a mano). */
  listarPendientesEntrega(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly PendienteEntregaOta[]>>;
  /** Datos de UNA reserva confirmada de la property para el mensaje manual; `valor: null` si no existe o es de otra property. */
  obtenerReservaParaMensaje(propertyId: string, ocupacionId: string): Promise<ResultadoAcceso<ReservaParaMensajeOta | null>>;
  /** Rn-P3-09: registra `entregada_manual` y saca la reserva de la liberacion automatica. Idempotente. */
  marcarEntregadaManual(ocupacionId: string, propertyId: string): Promise<ResultadoEntregaManual>;

  // ---- sistema (cron: sesión con auth.uid() NULL, una transacción por reserva) ----
  /** La siguiente reserva a liberar ahora; `null` si no hay más. Lanza (SQLSTATE 42883/42P01/42703) contra una base sin migrar. */
  siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null>;
  marcarLiberada(ocupacionId: string): Promise<boolean>;
  registrarEvento(ocupacionId: string, evento: EventoOmitidoAcceso): Promise<boolean>;
  /** Rn-P3-09: emite el aviso in-app `rentas.acceso.omitido_sin_contacto` (dedupe por reserva, sin PII). Best-effort: nunca lanza ni deja abortada la transaccion. Devuelve `true` si salio un aviso nuevo. */
  avisarOmitidaSinContacto(ocupacionId: string, organizationId: string, propertyId: string): Promise<boolean>;
  /** Rn-29: cifra las instrucciones heredadas en texto plano y SOLO entonces anula la columna en claro (idempotente). Lanza `AccesoNoDisponibleError` sin llave valida. */
  cifrarPendientes(limite: number): Promise<ResumenBarridoCifrado>;
}
