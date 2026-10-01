// Puerto de persistencia de GRUPOS (H-06). Separado de `HotelesRepository` (mismo criterio que agentes/tickets).
// El `actor` solo lo usa el repo en memoria (la base usa auth.uid() de la sesion y lo ignora). Cada operacion exige
// que la entidad pertenezca a la property de la URL (misma organizacion no basta).
import type {
  GrupoActor,
  BlockDetail,
  BlockListResult,
  NewQuoteInput,
  NewRoomingEntryInput,
  QuoteDetail,
  QuoteListResult,
  ReleasedBlock,
  RoomingEntryRecord,
} from "./tipos.ts";

export interface GruposRepository {
  // ---- cotizaciones ----
  /** Vacio honesto (`disponible: false`) sin la migracion 036. */
  listQuotes(propertyId: string): Promise<QuoteListResult>;
  getQuote(propertyId: string, quoteId: string): Promise<QuoteDetail | null>;
  createQuote(input: NewQuoteInput, actor: GrupoActor): Promise<QuoteDetail>;
  sendQuote(propertyId: string, quoteId: string, actor: GrupoActor, now?: Date): Promise<QuoteDetail>;
  closeQuote(propertyId: string, quoteId: string, outcome: "rechazada" | "cancelada", reason: string, actor: GrupoActor): Promise<QuoteDetail>;
  /** Acepta = bloquea cuartos (atomico, sin sobreventa). Devuelve el bloqueo creado. */
  acceptQuote(propertyId: string, quoteId: string, actor: GrupoActor, now?: Date): Promise<BlockDetail>;
  /** SOLO registra el anticipo (no cobra). */
  registerDeposit(propertyId: string, quoteId: string, amountCents: number, reference: string, actor: GrupoActor): Promise<QuoteDetail>;
  // ---- bloqueos, pickup y rooming ----
  listBlocks(propertyId: string): Promise<BlockListResult>;
  getBlock(propertyId: string, blockId: string): Promise<BlockDetail | null>;
  addRoomingEntry(propertyId: string, blockId: string, input: NewRoomingEntryInput, actor: GrupoActor): Promise<RoomingEntryRecord>;
  confirmRoomingEntry(propertyId: string, entryId: string, reservationId: string | null, actor: GrupoActor, now?: Date): Promise<RoomingEntryRecord>;
  cancelRoomingEntry(propertyId: string, entryId: string, actor: GrupoActor): Promise<RoomingEntryRecord>;
  /** Libera lo no confirmado de un bloqueo activo. Devuelve cuartos-noche liberados. */
  releaseBlock(propertyId: string, blockId: string, actor: GrupoActor, now?: Date): Promise<number>;
  cancelBlock(propertyId: string, blockId: string, reason: string, actor: GrupoActor): Promise<number>;
  // ---- SOLO sesion de sistema (sin cron programado: se invoca a mano o desde una ruta interna) ----
  /** Libera por cutoff los bloqueos activos cuya fecha de liberacion ya llego en la zona de CADA property. */
  releaseDueBlocks(propertyId: string | null, now: Date): Promise<readonly ReleasedBlock[]>;
  /** Vence las propuestas (borrador/enviada) cuya vigencia paso. */
  expireQuotes(now: Date): Promise<number>;
}
