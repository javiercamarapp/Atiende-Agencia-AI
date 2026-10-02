// Rn-24 / Rn-25 -- puerto de datos de los mensajes automaticos. Separado de RentasRepository y
// de RentasMensajeriaRepository a proposito (mismo criterio que RentasAccesoRepository): tablas y
// funciones nuevas de la migracion rentas 029, que pueden no existir todavia en la base real.
import type { CandidatoMensajeAutomatico, EntradaProgramacion, EventoAutomatico, ProgramacionMensaje, ResultadoMensajesAutomaticos } from "./tipos.ts";

export interface RentasMensajesAutomaticosRepository {
  // ---- staff (sesion del request, RLS real) ----
  /** Programaciones guardadas de la propiedad (las no guardadas no aparecen). */
  listarProgramaciones(propertyId: string): Promise<ResultadoMensajesAutomaticos<readonly ProgramacionMensaje[]>>;
  /** Upsert por (propiedad, evento). La plantilla debe ser de la organizacion y del mismo evento (FK compuesta en la base). */
  guardarProgramacion(entrada: EntradaProgramacion): Promise<ResultadoMensajesAutomaticos<ProgramacionMensaje>>;

  // ---- sistema (cron: sesion con auth.uid() NULL, una transaccion por reserva) ----
  /** Candidatas con disparo en (ahora - gracia, ahora]. Lanza (SQLSTATE 42883/42P01/42703) contra una base sin migrar. */
  listarCandidatos(ahora: Date, limite: number): Promise<readonly CandidatoMensajeAutomatico[]>;
  /** Crea el borrador `pendiente_aprobacion` + la marca de idempotencia. `null` si ya tenia marca o la programacion cambio. */
  crearBorradorAutomatico(entrada: { readonly ocupacionId: string; readonly evento: EventoAutomatico; readonly plantillaId: string; readonly texto: string }): Promise<string | null>;
  /** Marca la reserva+evento como omitida (plantilla no renderizable). `false` si ya tenia marca. */
  registrarOmitido(entrada: { readonly ocupacionId: string; readonly evento: EventoAutomatico; readonly plantillaId: string }): Promise<boolean>;
}
