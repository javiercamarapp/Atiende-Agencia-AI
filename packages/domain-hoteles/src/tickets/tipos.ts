// H-05 -- tipos y errores de dominio de los tickets de huesped.
import type { TicketChannel, TicketDepartment, TicketEventType, TicketPriority, TicketStatus } from "./sla.ts";

export interface GuestTicketRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly roomCode: string | null;
  readonly guestReviewId: string | null;
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
  readonly status: TicketStatus;
  readonly channel: TicketChannel;
  readonly guestMessage: string;
  readonly slaMinutes: number;
  readonly slaDueAt: string;
  readonly assignedTo: string | null;
  readonly escalatedAt: string | null;
  readonly escalatedToRoles: readonly string[];
  readonly slaWarningNotifiedAt: string | null;
  readonly resolutionNote: string | null;
  readonly closedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GuestTicketEventRecord {
  readonly id: string;
  readonly ticketId: string;
  readonly eventType: TicketEventType;
  /** `null` = el sistema (barrido de SLA). */
  readonly actorId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface NewGuestTicketInput {
  readonly propertyId: string;
  readonly roomId: string | null;
  readonly guestReviewId: string | null;
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
  readonly channel: TicketChannel;
  readonly guestMessage: string;
  /** SLA que propone la aplicacion; la politica de la property (si existe) lo sobreescribe en la base. */
  readonly slaMinutes: number;
  readonly assignedTo: string | null;
  readonly createdBy: string;
}

export interface GuestTicketFilter {
  readonly status?: TicketStatus;
  readonly department?: TicketDepartment;
  readonly assignedTo?: string;
  /** Solo tickets sin cerrar/cancelar. */
  readonly onlyActive?: boolean;
}

/** `disponible: false` = la base aun no tiene la migracion 034 (lista vacia honesta). */
export interface GuestTicketListResult {
  readonly disponible: boolean;
  readonly tickets: readonly GuestTicketRecord[];
}

export interface SlaPolicyRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
  readonly slaMinutes: number;
  readonly updatedAt: string;
}

export interface SlaPolicyListResult {
  readonly disponible: boolean;
  readonly politicas: readonly SlaPolicyRecord[];
}

/** Resena con queja que aun no tiene un ticket activo. */
export interface ReviewPendingTicket {
  readonly id: string;
  readonly source: string;
  readonly texto: string;
  readonly calificacion: number | null;
  readonly sentiment: string;
  readonly topics: readonly { readonly topic: string; readonly menciones: number }[];
  readonly createdAt: string;
}

export interface ReviewPendingListResult {
  readonly disponible: boolean;
  readonly resenas: readonly ReviewPendingTicket[];
}

export interface SlaSweepItem {
  readonly ticketId: string;
  readonly kind: "escalado" | "aviso_sla";
  readonly department: TicketDepartment;
  readonly priority: TicketPriority;
  readonly assignedTo: string | null;
}

export class TicketNotFoundError extends Error {
  constructor(what = "Ticket") {
    super(`${what} no encontrado, o sin permiso para verlo.`);
    this.name = "TicketNotFoundError";
  }
}
export class TicketConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketConflictError";
  }
}
export class TicketInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketInvalidInputError";
  }
}
export class TicketAccessDeniedError extends Error {
  constructor(message = "No tienes permiso para esta operacion sobre el ticket.") {
    super(message);
    this.name = "TicketAccessDeniedError";
  }
}
/** La base aun no tiene la migracion 034: las escrituras responden 503 honesto. */
export class TicketUnavailableError extends Error {
  constructor(public readonly operation: string) {
    super(`Tickets de huesped: la migracion 034 aun no esta aplicada (${operation}).`);
    this.name = "TicketUnavailableError";
  }
}
