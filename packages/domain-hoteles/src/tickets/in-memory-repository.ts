// Espejo en memoria de PostgresGuestTicketRepository (H-05) para tests de ruta/cron. NO emula
// RLS/GRANT/triggers (eso lo cubre scripts/verify-hoteles-tickets-sla contra Postgres real); SI
// replica las reglas de negocio visibles: politica de SLA que manda sobre el valor propuesto, SLA
// congelado al crear, transiciones validas, un ticket activo por resena, bitacora, barrido de SLA
// (escalar vencidos + aviso al 75%, idempotente) y la degradacion "base sin migrar".
import { randomUUID } from "node:crypto";
import type { GuestTicketRepository } from "./repository.ts";
import {
  TICKET_ESCALATION_ROLES,
  TICKET_TERMINAL_STATUSES,
  SLA_WARNING_THRESHOLD_RATIO,
  canTransitionTicket,
  computeSlaDueAt,
  isReviewTicketable,
} from "./sla.ts";
import type { TicketDepartment, TicketEventType, TicketPriority, TicketStatus } from "./sla.ts";
import { TicketConflictError, TicketInvalidInputError, TicketUnavailableError } from "./tipos.ts";
import type {
  GuestTicketEventRecord,
  GuestTicketFilter,
  GuestTicketListResult,
  GuestTicketRecord,
  NewGuestTicketInput,
  ReviewPendingListResult,
  ReviewPendingTicket,
  SlaPolicyListResult,
  SlaPolicyRecord,
  SlaSweepItem,
} from "./tipos.ts";

export class InMemoryGuestTicketRepository implements GuestTicketRepository {
  private readonly tickets = new Map<string, GuestTicketRecord>();
  private readonly events: GuestTicketEventRecord[] = [];
  private readonly policies = new Map<string, SlaPolicyRecord>();
  private readonly reviews = new Map<string, ReviewPendingTicket & { propertyId: string }>();
  private readonly staff = new Set<string>(); // `${propertyId}:${userId}`
  private readonly rooms = new Map<string, { propertyId: string; code: string }>();
  /** `false` simula una base SIN la migracion 034 (lecturas degradadas, escrituras 503). */
  migrated: boolean;
  private readonly now: () => Date;
  /** Actor de sistema: lo que `auth.uid()` seria en la base. `null` = sesion de sistema. */
  actorId: string | null = null;

  constructor(opts: { readonly migrated?: boolean; readonly now?: () => Date } = {}) {
    this.migrated = opts.migrated ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  seedStaff(propertyId: string, userId: string): void {
    this.staff.add(`${propertyId}:${userId}`);
  }
  seedRoom(room: { id: string; propertyId: string; code: string }): void {
    this.rooms.set(room.id, { propertyId: room.propertyId, code: room.code });
  }
  seedReview(review: ReviewPendingTicket & { propertyId: string }): void {
    this.reviews.set(review.id, review);
  }
  eventsOf(ticketId: string): readonly GuestTicketEventRecord[] {
    return this.events.filter((e) => e.ticketId === ticketId);
  }

  private requireMigrated(operation: string): void {
    if (!this.migrated) throw new TicketUnavailableError(operation);
  }

  private log(ticket: GuestTicketRecord, eventType: TicketEventType, actorId: string | null, detail: Record<string, unknown> = {}): void {
    this.events.push({ id: randomUUID(), ticketId: ticket.id, eventType, actorId, detail, createdAt: this.now().toISOString() });
  }

  private put(ticket: GuestTicketRecord): GuestTicketRecord {
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  private scoped(propertyId: string, ticketId: string): GuestTicketRecord | null {
    const t = this.tickets.get(ticketId);
    return t && t.propertyId === propertyId ? t : null;
  }

  async listTickets(propertyId: string, filter: GuestTicketFilter): Promise<GuestTicketListResult> {
    if (!this.migrated) return { disponible: false, tickets: [] };
    const rows = [...this.tickets.values()]
      .filter((t) => t.propertyId === propertyId)
      .filter((t) => !filter.status || t.status === filter.status)
      .filter((t) => !filter.department || t.department === filter.department)
      .filter((t) => !filter.assignedTo || t.assignedTo === filter.assignedTo)
      .filter((t) => !filter.onlyActive || !TICKET_TERMINAL_STATUSES.includes(t.status))
      .sort((a, b) => Number(TICKET_TERMINAL_STATUSES.includes(a.status)) - Number(TICKET_TERMINAL_STATUSES.includes(b.status)) || a.slaDueAt.localeCompare(b.slaDueAt));
    return { disponible: true, tickets: rows };
  }

  async findTicket(propertyId: string, ticketId: string): Promise<GuestTicketRecord | null> {
    return this.migrated ? this.scoped(propertyId, ticketId) : null;
  }

  async listEvents(propertyId: string, ticketId: string): Promise<readonly GuestTicketEventRecord[]> {
    if (!this.migrated || !this.scoped(propertyId, ticketId)) return [];
    return this.eventsOf(ticketId);
  }

  async createTicket(input: NewGuestTicketInput): Promise<GuestTicketRecord> {
    this.requireMigrated("createTicket");
    if (input.guestReviewId && input.channel !== "resena") throw new TicketInvalidInputError("guestReviewId exige canal resena.");
    if (input.guestReviewId && [...this.tickets.values()].some((t) => t.guestReviewId === input.guestReviewId && !TICKET_TERMINAL_STATUSES.includes(t.status))) {
      throw new TicketConflictError("Ya existe un ticket activo para esa resena.");
    }
    if (input.assignedTo && !this.staff.has(`${input.propertyId}:${input.assignedTo}`)) {
      throw new TicketInvalidInputError("El responsable no es staff de esta property.");
    }
    const policy = this.policies.get(policyKey(input.propertyId, input.department, input.priority));
    const slaMinutes = policy ? policy.slaMinutes : input.slaMinutes;
    const createdAt = this.now();
    const room = input.roomId ? this.rooms.get(input.roomId) : undefined;
    const ticket: GuestTicketRecord = {
      id: randomUUID(), propertyId: input.propertyId, roomId: input.roomId, roomCode: room?.code ?? null, guestReviewId: input.guestReviewId,
      department: input.department, priority: input.priority, status: "abierto", channel: input.channel, guestMessage: input.guestMessage,
      slaMinutes, slaDueAt: computeSlaDueAt(createdAt, slaMinutes).toISOString(), assignedTo: input.assignedTo, escalatedAt: null,
      escalatedToRoles: [], slaWarningNotifiedAt: null, resolutionNote: null, closedAt: null, createdBy: input.createdBy,
      createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    };
    this.put(ticket);
    this.log(ticket, "creado", input.createdBy, { departamento: ticket.department, prioridad: ticket.priority, canal: ticket.channel, slaMinutos: slaMinutes });
    return ticket;
  }

  async setStatus(propertyId: string, ticketId: string, to: TicketStatus, note: string | null): Promise<GuestTicketRecord | null> {
    this.requireMigrated("setStatus");
    const t = this.scoped(propertyId, ticketId);
    if (!t) return null;
    if (t.status === to) return t;
    if (!canTransitionTicket(t.status, to)) throw new TicketInvalidInputError(`Transicion invalida: ${t.status} -> ${to}.`);
    const nowIso = this.now().toISOString();
    const next: GuestTicketRecord = {
      ...t,
      status: to,
      updatedAt: nowIso,
      resolutionNote: to === "cerrado" ? (note ?? t.resolutionNote) : t.resolutionNote,
      ...(to === "escalado" ? { escalatedAt: nowIso, escalatedToRoles: [...TICKET_ESCALATION_ROLES] } : {}),
      ...(TICKET_TERMINAL_STATUSES.includes(to) ? { closedAt: nowIso } : {}),
    };
    this.put(next);
    this.log(next, to === "abierto" ? "en_progreso" : (to as TicketEventType), this.actorId, to === "escalado" ? { origen: "manual", escaladoARoles: next.escalatedToRoles } : to === "cerrado" ? { nota: next.resolutionNote } : {});
    return next;
  }

  async assignTicket(propertyId: string, ticketId: string, assignedTo: string | null): Promise<GuestTicketRecord | null> {
    this.requireMigrated("assignTicket");
    const t = this.scoped(propertyId, ticketId);
    if (!t) return null;
    if (TICKET_TERMINAL_STATUSES.includes(t.status)) throw new TicketInvalidInputError(`El ticket ya esta ${t.status}.`);
    if (assignedTo && !this.staff.has(`${propertyId}:${assignedTo}`)) throw new TicketInvalidInputError("El responsable no es staff de esta property.");
    const next = this.put({ ...t, assignedTo, updatedAt: this.now().toISOString() });
    if (assignedTo !== t.assignedTo) this.log(next, "asignado", this.actorId, { de: t.assignedTo, a: assignedTo });
    return next;
  }

  async reassignDepartment(propertyId: string, ticketId: string, department: TicketDepartment): Promise<GuestTicketRecord | null> {
    this.requireMigrated("reassignDepartment");
    const t = this.scoped(propertyId, ticketId);
    if (!t) return null;
    if (TICKET_TERMINAL_STATUSES.includes(t.status)) throw new TicketInvalidInputError(`El ticket ya esta ${t.status}.`);
    // El SLA queda congelado: ni slaMinutes ni slaDueAt cambian al reasignar.
    const next = this.put({ ...t, department, updatedAt: this.now().toISOString() });
    if (department !== t.department) this.log(next, "departamento_cambiado", this.actorId, { de: t.department, a: department });
    return next;
  }

  async listSlaPolicies(propertyId: string): Promise<SlaPolicyListResult> {
    if (!this.migrated) return { disponible: false, politicas: [] };
    return { disponible: true, politicas: [...this.policies.values()].filter((p) => p.propertyId === propertyId) };
  }

  async upsertSlaPolicy(propertyId: string, department: TicketDepartment, priority: TicketPriority, slaMinutes: number): Promise<SlaPolicyRecord> {
    this.requireMigrated("upsertSlaPolicy");
    if (!Number.isInteger(slaMinutes) || slaMinutes < 1 || slaMinutes > 43200) throw new TicketInvalidInputError("slaMinutes fuera de rango (1..43200).");
    const key = policyKey(propertyId, department, priority);
    const existing = this.policies.get(key);
    const policy: SlaPolicyRecord = { id: existing?.id ?? randomUUID(), propertyId, department, priority, slaMinutes, updatedAt: this.now().toISOString() };
    this.policies.set(key, policy);
    return policy;
  }

  async listReviewsPendingTicket(propertyId: string, limit: number): Promise<ReviewPendingListResult> {
    if (!this.migrated) return { disponible: false, resenas: [] };
    const withTicket = new Set([...this.tickets.values()].map((t) => t.guestReviewId).filter((id): id is string => !!id));
    const resenas = [...this.reviews.values()]
      .filter((r) => r.propertyId === propertyId && isReviewTicketable(r) && !withTicket.has(r.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ propertyId: _p, ...rest }) => rest);
    return { disponible: true, resenas };
  }

  async sweepSla(propertyId: string, now: Date): Promise<readonly SlaSweepItem[]> {
    this.requireMigrated("sweepSla");
    const items: SlaSweepItem[] = [];
    for (const t of [...this.tickets.values()]) {
      if (t.propertyId !== propertyId || (t.status !== "abierto" && t.status !== "en_progreso")) continue;
      const due = new Date(t.slaDueAt).getTime();
      if (due < now.getTime()) {
        const next = this.put({ ...t, status: "escalado", escalatedAt: now.toISOString(), escalatedToRoles: [...TICKET_ESCALATION_ROLES], updatedAt: now.toISOString() });
        this.log(next, "escalado", null, { origen: "sla_vencido", escaladoARoles: next.escalatedToRoles });
        items.push({ ticketId: t.id, kind: "escalado", department: t.department, priority: t.priority, assignedTo: t.assignedTo });
      } else if (t.slaWarningNotifiedAt === null && new Date(t.createdAt).getTime() + t.slaMinutes * SLA_WARNING_THRESHOLD_RATIO * 60_000 <= now.getTime()) {
        const next = this.put({ ...t, slaWarningNotifiedAt: now.toISOString(), updatedAt: now.toISOString() });
        this.log(next, "aviso_sla", null, { slaVenceEn: t.slaDueAt });
        items.push({ ticketId: t.id, kind: "aviso_sla", department: t.department, priority: t.priority, assignedTo: t.assignedTo });
      }
    }
    return items;
  }
}

function policyKey(propertyId: string, department: string, priority: string): string {
  return `${propertyId}:${department}:${priority}`;
}
