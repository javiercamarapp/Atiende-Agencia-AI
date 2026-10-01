// Puerto de persistencia de los tickets de huesped (H-05). Separado de `HotelesRepository` (mismo
// criterio que housekeeping/identidad) para no ensanchar el puerto grande. Las transiciones llevan
// guarda de estado en SQL; devuelven `null` si el ticket no existe o no es visible para el actor.
import type {
  GuestTicketEventRecord,
  GuestTicketFilter,
  GuestTicketListResult,
  GuestTicketRecord,
  NewGuestTicketInput,
  ReviewPendingListResult,
  SlaPolicyListResult,
  SlaPolicyRecord,
  SlaSweepItem,
} from "./tipos.ts";
import type { TicketDepartment, TicketPriority, TicketStatus } from "./sla.ts";

export interface GuestTicketRepository {
  /** Lista los tickets visibles para el actor (la RLS filtra por rol). Vacio honesto sin migracion 034. */
  listTickets(propertyId: string, filter: GuestTicketFilter): Promise<GuestTicketListResult>;
  findTicket(propertyId: string, ticketId: string): Promise<GuestTicketRecord | null>;
  listEvents(propertyId: string, ticketId: string): Promise<readonly GuestTicketEventRecord[]>;
  createTicket(input: NewGuestTicketInput): Promise<GuestTicketRecord>;
  /** Cambia el estado (la base valida la transicion). `note` solo aplica a cerrar. */
  setStatus(propertyId: string, ticketId: string, to: TicketStatus, note: string | null): Promise<GuestTicketRecord | null>;
  /** `assignedTo: null` quita al responsable. */
  assignTicket(propertyId: string, ticketId: string, assignedTo: string | null): Promise<GuestTicketRecord | null>;
  reassignDepartment(propertyId: string, ticketId: string, department: TicketDepartment): Promise<GuestTicketRecord | null>;

  listSlaPolicies(propertyId: string): Promise<SlaPolicyListResult>;
  upsertSlaPolicy(propertyId: string, department: TicketDepartment, priority: TicketPriority, slaMinutes: number): Promise<SlaPolicyRecord>;

  /** Resenas negativas de la property sin ticket activo (insumo de "crear ticket desde resena"). */
  listReviewsPendingTicket(propertyId: string, limit: number): Promise<ReviewPendingListResult>;

  /** SOLO sesion de sistema (cron): escala los vencidos y avisa al 75%. Lanza TicketUnavailableError sin 034. */
  sweepSla(propertyId: string, now: Date): Promise<readonly SlaSweepItem[]>;
}
