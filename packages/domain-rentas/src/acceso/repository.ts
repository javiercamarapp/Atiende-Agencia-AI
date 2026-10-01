// Rn-04 -- puerto de datos de la liberación de acceso. Separado de RentasRepository a
// propósito (mismo criterio que RentasCalendarSyncRepository): tablas nuevas de la
// migración 025, que pueden no existir todavía en la base real.
import type { EntradaInstruccion, EntradaPolitica } from "./validacion.ts";
import type { EventoAccesoRecord, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PoliticaAcceso, ResultadoAcceso, ResultadoConfirmarPago } from "./tipos.ts";

export interface RentasAccesoRepository {
  // ---- staff (sesión del request, RLS real) ----
  /** `null` valor = la property no tiene política (equivale a APAGADA). */
  obtenerPolitica(propertyId: string): Promise<ResultadoAcceso<PoliticaAcceso | null>>;
  guardarPolitica(organizationId: string, propertyId: string, entrada: EntradaPolitica, actorId: string): Promise<ResultadoAcceso<PoliticaAcceso>>;
  obtenerInstruccion(propertyId: string, unidadId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>>;
  /** `valor: null` si la unidad no pertenece a la property. */
  guardarInstruccion(organizationId: string, propertyId: string, unidadId: string, entrada: EntradaInstruccion, actorId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>>;
  confirmarPago(ocupacionId: string, confirmado: boolean): Promise<ResultadoConfirmarPago>;
  listarBitacora(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly EventoAccesoRecord[]>>;

  // ---- sistema (cron: sesión con auth.uid() NULL, una transacción por reserva) ----
  /** La siguiente reserva a liberar ahora; `null` si no hay más. Lanza (SQLSTATE 42883/42P01/42703) contra una base sin migrar. */
  siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null>;
  marcarLiberada(ocupacionId: string): Promise<boolean>;
  registrarEvento(ocupacionId: string, evento: EventoOmitidoAcceso): Promise<boolean>;
}
