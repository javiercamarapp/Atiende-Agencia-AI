// Adaptador Postgres de los tickets de huesped (H-05) sobre `TenantDbSession` (auth.uid() real por
// request, RLS real). REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA
// transaccion por request; un error de Postgres (42P01 si la migracion 034 no esta aplicada) la
// dejaria ABORTADA (25P02). Toda operacion corre dentro de `runWithSavepointFallback`: las lecturas
// degradan a vacio honesto (`disponible: false`), las escrituras a `TicketUnavailableError` (503).
// El SQL es el MISMO que ejercita scripts/verify-hoteles-tickets-sla contra Postgres real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { GuestTicketRepository } from "./repository.ts";
import type { TicketChannel, TicketDepartment, TicketEventType, TicketPriority, TicketStatus } from "./sla.ts";
import {
  TicketAccessDeniedError,
  TicketConflictError,
  TicketInvalidInputError,
  TicketNotFoundError,
  TicketUnavailableError,
} from "./tipos.ts";
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

const TICKET_SELECT = `t.id, t.property_id, t.room_id, r.code as room_code, t.guest_review_id, t.department, t.priority, t.status, t.channel,
       t.guest_message, t.sla_minutes, t.sla_due_at::text as sla_due_at, t.assigned_to, t.escalated_at::text as escalated_at,
       t.escalated_to_roles, t.sla_warning_notified_at::text as sla_warning_notified_at, t.resolution_note,
       t.closed_at::text as closed_at, t.created_by, t.created_at::text as created_at, t.updated_at::text as updated_at`;
const TICKET_FROM = `from hoteles.guest_ticket t left join hoteles.room r on r.id = t.room_id`;

interface TicketRow {
  id: string; property_id: string; room_id: string | null; room_code: string | null; guest_review_id: string | null;
  department: TicketDepartment; priority: TicketPriority; status: TicketStatus; channel: TicketChannel; guest_message: string;
  sla_minutes: number; sla_due_at: string; assigned_to: string | null; escalated_at: string | null; escalated_to_roles: unknown;
  sla_warning_notified_at: string | null; resolution_note: string | null; closed_at: string | null; created_by: string | null;
  created_at: string; updated_at: string;
}

function parseRoles(value: unknown): readonly string[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
}
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapTicket(r: TicketRow): GuestTicketRecord {
  return {
    id: r.id, propertyId: r.property_id, roomId: r.room_id, roomCode: r.room_code, guestReviewId: r.guest_review_id,
    department: r.department, priority: r.priority, status: r.status, channel: r.channel, guestMessage: r.guest_message,
    slaMinutes: Number(r.sla_minutes), slaDueAt: r.sla_due_at, assignedTo: r.assigned_to, escalatedAt: r.escalated_at,
    escalatedToRoles: parseRoles(r.escalated_to_roles), slaWarningNotifiedAt: r.sla_warning_notified_at, resolutionNote: r.resolution_note,
    closedAt: r.closed_at, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce un error de Postgres a un error de dominio tipado (nunca un 500 crudo). */
export function mapTicketPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof TicketNotFoundError || err instanceof TicketConflictError || err instanceof TicketInvalidInputError ||
    err instanceof TicketAccessDeniedError || err instanceof TicketUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new TicketUnavailableError(operation);
  switch (pgCode(err)) {
    case "23503":
      return new TicketNotFoundError("Habitacion, resena o responsable");
    case "23505":
      return new TicketConflictError("Ya existe un ticket activo para esa resena (o una politica de SLA para ese departamento y prioridad).");
    case "23514":
      return new TicketInvalidInputError("Datos invalidos para el ticket (estado no permitido, dato fuera de rango, o el responsable no es staff de esta property).");
    case "22023":
      return new TicketInvalidInputError("Parametro invalido para el barrido de SLA.");
    case "42501":
      return new TicketAccessDeniedError();
    default:
      return err;
  }
}

export class PostgresGuestTicketRepository implements GuestTicketRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapTicketPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se repropaga. */
  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        console.warn(`${operation}: tickets de huesped (migracion 034) aun no aplicada -- degradando:`, err instanceof Error ? err.message : err);
        return Promise.resolve(onMissing());
      },
    });
  }

  async listTickets(propertyId: string, filter: GuestTicketFilter): Promise<GuestTicketListResult> {
    return this.read<GuestTicketListResult>(
      "listTickets",
      async () => {
        const { rows } = await this.db.query<TicketRow>(
          `select ${TICKET_SELECT} ${TICKET_FROM}
            where t.property_id = $1
              and ($2::text is null or t.status = $2)
              and ($3::text is null or t.department = $3)
              and ($4::uuid is null or t.assigned_to = $4)
              and (not $5::boolean or t.status not in ('cerrado', 'cancelado'))
            order by (t.status in ('cerrado', 'cancelado')), t.sla_due_at asc, t.created_at desc
            limit 200;`,
          [propertyId, filter.status ?? null, filter.department ?? null, filter.assignedTo ?? null, filter.onlyActive ?? false],
        );
        return { disponible: true, tickets: rows.map(mapTicket) };
      },
      () => ({ disponible: false, tickets: [] }),
    );
  }

  async findTicket(propertyId: string, ticketId: string): Promise<GuestTicketRecord | null> {
    return this.read<GuestTicketRecord | null>(
      "findTicket",
      async () => {
        const { rows } = await this.db.query<TicketRow>(`select ${TICKET_SELECT} ${TICKET_FROM} where t.property_id = $1 and t.id = $2;`, [propertyId, ticketId]);
        return rows[0] ? mapTicket(rows[0]) : null;
      },
      () => null,
    );
  }

  async listEvents(propertyId: string, ticketId: string): Promise<readonly GuestTicketEventRecord[]> {
    return this.read<readonly GuestTicketEventRecord[]>(
      "listEvents",
      async () => {
        const { rows } = await this.db.query<{ id: string; ticket_id: string; event_type: TicketEventType; actor_id: string | null; detail: unknown; created_at: string }>(
          `select e.id, e.ticket_id, e.event_type, e.actor_id, e.detail, e.created_at::text as created_at
             from hoteles.guest_ticket_event e where e.property_id = $1 and e.ticket_id = $2 order by e.created_at asc, e.id asc;`,
          [propertyId, ticketId],
        );
        return rows.map((e) => ({
          id: e.id, ticketId: e.ticket_id, eventType: e.event_type, actorId: e.actor_id, createdAt: e.created_at,
          detail: e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {},
        }));
      },
      () => [],
    );
  }

  async createTicket(input: NewGuestTicketInput): Promise<GuestTicketRecord> {
    return this.write("createTicket", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `insert into hoteles.guest_ticket (property_id, room_id, guest_review_id, department, priority, channel, guest_message, sla_minutes, assigned_to)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id;`,
        [input.propertyId, input.roomId, input.guestReviewId, input.department, input.priority, input.channel, input.guestMessage, input.slaMinutes, input.assignedTo],
      );
      const created = await this.loadAfterWrite(input.propertyId, rows[0]!.id);
      if (!created) throw new TicketNotFoundError();
      return created;
    });
  }

  private async loadAfterWrite(propertyId: string, ticketId: string): Promise<GuestTicketRecord | null> {
    const { rows } = await this.db.query<TicketRow>(`select ${TICKET_SELECT} ${TICKET_FROM} where t.property_id = $1 and t.id = $2;`, [propertyId, ticketId]);
    return rows[0] ? mapTicket(rows[0]) : null;
  }

  async setStatus(propertyId: string, ticketId: string, to: TicketStatus, note: string | null): Promise<GuestTicketRecord | null> {
    return this.write("setStatus", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `update hoteles.guest_ticket
            set status = $3, resolution_note = case when $3 = 'cerrado' then coalesce($4, resolution_note) else resolution_note end
          where property_id = $1 and id = $2 returning id;`,
        [propertyId, ticketId, to, note],
      );
      return rows[0] ? this.loadAfterWrite(propertyId, rows[0].id) : null;
    });
  }

  async assignTicket(propertyId: string, ticketId: string, assignedTo: string | null): Promise<GuestTicketRecord | null> {
    return this.write("assignTicket", async () => {
      const { rows } = await this.db.query<{ id: string }>(`update hoteles.guest_ticket set assigned_to = $3 where property_id = $1 and id = $2 returning id;`, [propertyId, ticketId, assignedTo]);
      return rows[0] ? this.loadAfterWrite(propertyId, rows[0].id) : null;
    });
  }

  async reassignDepartment(propertyId: string, ticketId: string, department: TicketDepartment): Promise<GuestTicketRecord | null> {
    return this.write("reassignDepartment", async () => {
      const { rows } = await this.db.query<{ id: string }>(`update hoteles.guest_ticket set department = $3 where property_id = $1 and id = $2 returning id;`, [propertyId, ticketId, department]);
      return rows[0] ? this.loadAfterWrite(propertyId, rows[0].id) : null;
    });
  }

  async listSlaPolicies(propertyId: string): Promise<SlaPolicyListResult> {
    return this.read<SlaPolicyListResult>(
      "listSlaPolicies",
      async () => {
        const { rows } = await this.db.query<{ id: string; property_id: string; department: TicketDepartment; priority: TicketPriority; sla_minutes: number; updated_at: string }>(
          `select id, property_id, department, priority, sla_minutes, updated_at::text as updated_at
             from hoteles.ticket_sla_policy where property_id = $1 order by department, priority;`,
          [propertyId],
        );
        return { disponible: true, politicas: rows.map(mapPolicy) };
      },
      () => ({ disponible: false, politicas: [] }),
    );
  }

  async upsertSlaPolicy(propertyId: string, department: TicketDepartment, priority: TicketPriority, slaMinutes: number): Promise<SlaPolicyRecord> {
    return this.write("upsertSlaPolicy", async () => {
      const { rows } = await this.db.query<{ id: string; property_id: string; department: TicketDepartment; priority: TicketPriority; sla_minutes: number; updated_at: string }>(
        `insert into hoteles.ticket_sla_policy (property_id, department, priority, sla_minutes) values ($1, $2, $3, $4)
         on conflict (property_id, department, priority) do update set sla_minutes = excluded.sla_minutes
         returning id, property_id, department, priority, sla_minutes, updated_at::text as updated_at;`,
        [propertyId, department, priority, slaMinutes],
      );
      return mapPolicy(rows[0]!);
    });
  }

  async listReviewsPendingTicket(propertyId: string, limit: number): Promise<ReviewPendingListResult> {
    return this.read<ReviewPendingListResult>(
      "listReviewsPendingTicket",
      async () => {
        const { rows } = await this.db.query<{ id: string; source: string; texto: string; calificacion: number | null; sentiment: string; topics: unknown; created_at: string }>(
          `select r.id, r.source::text as source, r.texto, r.calificacion, r.sentiment::text as sentiment, r.topics, r.created_at::text as created_at
             from hoteles.guest_review r
            where r.property_id = $1 and r.sentiment in ('negativo', 'muy_negativo')
              and not exists (select 1 from hoteles.guest_ticket t where t.guest_review_id = r.id)
            order by r.created_at desc limit $2;`,
          [propertyId, limit],
        );
        return {
          disponible: true,
          resenas: rows.map((r) => ({
            id: r.id, source: r.source, texto: r.texto, calificacion: r.calificacion === null ? null : Number(r.calificacion), sentiment: r.sentiment,
            createdAt: r.created_at, topics: parseTopics(r.topics),
          })),
        };
      },
      () => ({ disponible: false, resenas: [] }),
    );
  }

  async sweepSla(propertyId: string, now: Date): Promise<readonly SlaSweepItem[]> {
    return this.write("sweepSla", async () => {
      const { rows } = await this.db.query<{ out_ticket_id: string; out_kind: "escalado" | "aviso_sla"; out_department: TicketDepartment; out_priority: TicketPriority; out_assigned_to: string | null }>(
        `select out_ticket_id, out_kind, out_department, out_priority, out_assigned_to from hoteles.sweep_guest_ticket_sla($1, $2::timestamptz);`,
        [propertyId, now.toISOString()],
      );
      return rows.map((r) => ({ ticketId: r.out_ticket_id, kind: r.out_kind, department: r.out_department, priority: r.out_priority, assignedTo: r.out_assigned_to }));
    });
  }
}

function mapPolicy(r: { id: string; property_id: string; department: TicketDepartment; priority: TicketPriority; sla_minutes: number; updated_at: string }): SlaPolicyRecord {
  return { id: r.id, propertyId: r.property_id, department: r.department, priority: r.priority, slaMinutes: Number(r.sla_minutes), updatedAt: r.updated_at };
}

function parseTopics(value: unknown): readonly { readonly topic: string; readonly menciones: number }[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((t): t is { topic: string; menciones?: unknown } => !!t && typeof t === "object" && typeof (t as { topic?: unknown }).topic === "string")
    .map((t) => ({ topic: t.topic, menciones: typeof t.menciones === "number" ? t.menciones : 1 }));
}
