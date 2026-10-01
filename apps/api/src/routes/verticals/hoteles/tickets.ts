// H-05 (migracion 034) -- tickets de huesped con SLA, escalacion automatica, bitacora y creacion
// desde resenas. Mismo montaje que housekeeping.ts: authMiddleware + dbSession +
// requirePropertyMembership("propertyId"), filtrado fino con assertVerticalRole en cada handler (la
// RLS de hoteles.guest_ticket es la autoridad final y filtra por rol: manager ve todos, los demas los
// de su departamento / asignados / reportados por ellos).
//
// REGLA DURA DE COMPATIBILIDAD: contra una base sin la migracion 034 las lecturas degradan
// (`disponible: false`, listas vacias) y las escrituras responden 503 -- nunca un 500.
//
// El barrido automatico de SLA vive en tickets-sla-cron.ts (sesion de sistema, transaccion por property).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  GUEST_TICKET_ACCESS_ROLES,
  GUEST_TICKET_FROM_REVIEW_ROLES,
  GUEST_TICKET_MANAGE_ROLES,
  GUEST_TICKET_SLA_POLICY_ROLES,
  PostgresGuestTicketRepository,
  TICKET_CHANNELS,
  TICKET_DEPARTMENTS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TicketAccessDeniedError,
  TicketConflictError,
  TicketInvalidInputError,
  TicketNotFoundError,
  TicketUnavailableError,
  actorMayOperateTicket,
  canTransitionTicket,
  classifyGuestMessage,
  DEFAULT_SLA_MINUTES_BY_PRIORITY,
  draftTicketFromReview,
  isReviewTicketable,
  minutesToSlaDue,
  resolveSlaMinutes,
  slaState,
  type GuestTicketEventRecord,
  type GuestTicketRecord,
  type GuestTicketRepository,
  type SlaPolicyRecord,
  type TicketChannel,
  type TicketDepartment,
  type TicketStatus,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Canales que puede declarar quien registra a mano: `resena` solo lo produce `desde-resena`. */
const MANUAL_CHANNELS: readonly TicketChannel[] = TICKET_CHANNELS.filter((c) => c !== "resena");

function serializeTicket(t: GuestTicketRecord, now: Date) {
  return {
    id: t.id,
    habitacionId: t.roomId,
    habitacion: t.roomCode,
    resenaId: t.guestReviewId,
    departamento: t.department,
    prioridad: t.priority,
    estado: t.status,
    canal: t.channel,
    mensaje: t.guestMessage,
    slaMinutos: t.slaMinutes,
    slaVenceEn: t.slaDueAt,
    estadoSla: slaState(t, now),
    minutosParaVencer: minutesToSlaDue(t.slaDueAt, now),
    asignadoA: t.assignedTo,
    escaladoEn: t.escalatedAt,
    escaladoARoles: t.escalatedToRoles,
    avisoSla75En: t.slaWarningNotifiedAt,
    notaResolucion: t.resolutionNote,
    cerradoEn: t.closedAt,
    creadoPor: t.createdBy,
    creadoEn: t.createdAt,
    actualizadoEn: t.updatedAt,
  };
}

function serializeEvent(e: GuestTicketEventRecord) {
  return { id: e.id, tipo: e.eventType, actorId: e.actorId, sistema: e.actorId === null, detalle: e.detail, creadoEn: e.createdAt };
}

function serializePolicy(p: SlaPolicyRecord) {
  return { id: p.id, departamento: p.department, prioridad: p.priority, minutos: p.slaMinutes, actualizadoEn: p.updatedAt };
}

/** Traduce los errores de dominio de tickets a respuestas HTTP (nunca un 500 crudo). */
function toApiError(err: unknown): unknown {
  if (err instanceof TicketUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof TicketNotFoundError) return Errors.notFound(err.message);
  if (err instanceof TicketConflictError) return Errors.conflict(err.message);
  if (err instanceof TicketInvalidInputError) return Errors.validation(err.message);
  if (err instanceof TicketAccessDeniedError) return Errors.forbidden(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${field}: se esperaba un UUID.`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw Errors.validation(`${field}: texto de maximo ${max} caracteres.`);
  return value.trim() || null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw Errors.validation(`${field}: se esperaba ${allowed.join("|")}.`);
  return value as T;
}

export function hotelesTicketsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const clock = () => new Date();

  app.use("/hoteles/:propertyId/tickets/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/tickets", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function repoOf(c: Context<CoreAuthHonoEnv>): GuestTicketRepository {
    const db = c.get("db");
    return deps.hotelesTicketsRepo ? deps.hotelesTicketsRepo(db) : new PostgresGuestTicketRepository(db);
  }

  async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await c.req.json().catch(() => ({}));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  // ---- listado y creacion ---------------------------------------------------------------

  app.get("/hoteles/:propertyId/tickets", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_ACCESS_ROLES);
    const estado = c.req.query("estado");
    const departamento = c.req.query("departamento");
    const asignadoA = c.req.query("asignadoA");
    const now = clock();
    const result = await guarded(() =>
      repoOf(c).listTickets(c.req.param("propertyId"), {
        ...(estado ? { status: oneOf(estado, TICKET_STATUSES, "estado") } : {}),
        ...(departamento ? { department: oneOf(departamento, TICKET_DEPARTMENTS, "departamento") } : {}),
        ...(asignadoA ? { assignedTo: requireUuid(asignadoA, "asignadoA") } : {}),
        ...(c.req.query("activos") === "1" ? { onlyActive: true } : {}),
      }),
    );
    return c.json({ disponible: result.disponible, ahora: now.toISOString(), tickets: result.tickets.map((t) => serializeTicket(t, now)) });
  });

  app.post("/hoteles/:propertyId/tickets", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_ACCESS_ROLES);
    const raw = await readBody(c);
    const mensaje = optionalText(raw.mensaje, "mensaje", 1000);
    if (!mensaje) throw Errors.validation("mensaje: requerido, maximo 1000 caracteres.");
    const inferred = raw.departamento === undefined || raw.prioridad === undefined ? classifyGuestMessage(mensaje) : null;
    const department = raw.departamento === undefined ? inferred!.department : oneOf(raw.departamento, TICKET_DEPARTMENTS, "departamento");
    const priority = raw.prioridad === undefined ? inferred!.priority : oneOf(raw.prioridad, TICKET_PRIORITIES, "prioridad");
    const channel = raw.canal === undefined ? "staff" : oneOf(raw.canal, MANUAL_CHANNELS, "canal");
    const roomId = raw.habitacionId === undefined || raw.habitacionId === null ? null : requireUuid(raw.habitacionId, "habitacionId");
    const assignedTo = raw.asignadoA === undefined || raw.asignadoA === null ? null : requireUuid(raw.asignadoA, "asignadoA");
    if (assignedTo && !GUEST_TICKET_MANAGE_ROLES.includes((c.get("verticalRole") ?? "") as never) && assignedTo !== c.get("userId")) {
      throw Errors.forbidden("Solo owner/gm/frontdesk asignan un ticket a otra persona.");
    }
    const now = clock();
    const created = await guarded(() =>
      repoOf(c).createTicket({
        propertyId: c.req.param("propertyId"),
        roomId,
        guestReviewId: null,
        department,
        priority,
        channel,
        guestMessage: mensaje,
        // La politica de la property (si existe) sobreescribe este valor en la base.
        slaMinutes: resolveSlaMinutes(null, priority),
        assignedTo,
        createdBy: c.get("userId"),
      }),
    );
    return c.json({ ...serializeTicket(created, now), clasificadoAutomaticamente: inferred !== null }, 201);
  });

  // ---- politica de SLA ------------------------------------------------------------------

  app.get("/hoteles/:propertyId/tickets/sla", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_ACCESS_ROLES);
    const result = await guarded(() => repoOf(c).listSlaPolicies(c.req.param("propertyId")));
    const configured = new Map(result.politicas.map((p) => [`${p.department}:${p.priority}`, p.slaMinutes]));
    return c.json({
      disponible: result.disponible,
      porDefecto: DEFAULT_SLA_MINUTES_BY_PRIORITY,
      politicas: result.politicas.map(serializePolicy),
      // Tabla efectiva departamento x prioridad: lo configurado o el default por prioridad.
      efectiva: TICKET_DEPARTMENTS.flatMap((d) =>
        TICKET_PRIORITIES.map((p) => ({ departamento: d, prioridad: p, minutos: resolveSlaMinutes(configured.get(`${d}:${p}`), p), configurada: configured.has(`${d}:${p}`) })),
      ),
    });
  });

  app.put("/hoteles/:propertyId/tickets/sla", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_SLA_POLICY_ROLES);
    const raw = await readBody(c);
    const department = oneOf(raw.departamento, TICKET_DEPARTMENTS, "departamento");
    const priority = oneOf(raw.prioridad, TICKET_PRIORITIES, "prioridad");
    const minutos = raw.minutos;
    if (typeof minutos !== "number" || !Number.isInteger(minutos) || minutos < 1 || minutos > 43200) throw Errors.validation("minutos: entero entre 1 y 43200.");
    const policy = await guarded(() => repoOf(c).upsertSlaPolicy(c.req.param("propertyId"), department, priority, minutos));
    return c.json(serializePolicy(policy));
  });

  // ---- reseñas -> ticket ----------------------------------------------------------------

  app.get("/hoteles/:propertyId/tickets/resenas-pendientes", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_FROM_REVIEW_ROLES);
    const result = await guarded(() => repoOf(c).listReviewsPendingTicket(c.req.param("propertyId"), 50));
    return c.json({
      disponible: result.disponible,
      resenas: result.resenas.map((r) => ({
        id: r.id,
        fuente: r.source,
        texto: r.texto,
        calificacion: r.calificacion,
        sentimiento: r.sentiment,
        temas: r.topics.map((t) => t.topic),
        creadaEn: r.createdAt,
        sugerencia: (({ department, priority }) => ({ departamento: department, prioridad: priority }))(draftTicketFromReview(r)),
      })),
    });
  });

  app.post("/hoteles/:propertyId/tickets/desde-resena", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_FROM_REVIEW_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readBody(c);
    const reviewId = requireUuid(raw.resenaId, "resenaId");
    // Reutiliza la resena ya capturada y clasificada (hoteles.guest_review, migracion 013); la RLS de
    // resenas decide si el actor la ve (si no, 404).
    const review = await deps.hotelesRepo(c.get("db")).findGuestReview(propertyId, reviewId);
    if (!review) throw Errors.notFound("Resena no encontrada.");
    if (!isReviewTicketable(review)) throw Errors.validation("Solo las resenas negativas o muy negativas generan un ticket.");
    const draft = draftTicketFromReview(review);
    const department = raw.departamento === undefined ? draft.department : oneOf(raw.departamento, TICKET_DEPARTMENTS, "departamento");
    const priority = raw.prioridad === undefined ? draft.priority : oneOf(raw.prioridad, TICKET_PRIORITIES, "prioridad");
    const assignedTo = raw.asignadoA === undefined || raw.asignadoA === null ? null : requireUuid(raw.asignadoA, "asignadoA");
    const now = clock();
    const created = await guarded(() =>
      repoOf(c).createTicket({
        propertyId,
        roomId: null,
        guestReviewId: review.id,
        department,
        priority,
        channel: "resena",
        guestMessage: draft.guestMessage,
        slaMinutes: resolveSlaMinutes(null, priority),
        assignedTo,
        createdBy: c.get("userId"),
      }),
    );
    return c.json(serializeTicket(created, now), 201);
  });

  // ---- detalle y acciones ---------------------------------------------------------------

  app.get("/hoteles/:propertyId/tickets/:ticketId", async (c) => {
    assertVerticalRole(c, GUEST_TICKET_ACCESS_ROLES);
    const propertyId = c.req.param("propertyId");
    const ticketId = requireUuid(c.req.param("ticketId"), "ticketId");
    const repo = repoOf(c);
    const ticket = await guarded(() => repo.findTicket(propertyId, ticketId));
    if (!ticket) throw Errors.notFound("Ticket no encontrado.");
    const events = await guarded(() => repo.listEvents(propertyId, ticketId));
    return c.json({ ...serializeTicket(ticket, clock()), bitacora: events.map(serializeEvent) });
  });

  /** Carga el ticket (visible por RLS), exige poder operarlo y, si aplica, que la transicion sea valida. */
  async function loadForAction(c: Context<CoreAuthHonoEnv>, opts: { to?: TicketStatus; managerOnly?: boolean }) {
    assertVerticalRole(c, opts.managerOnly ? GUEST_TICKET_MANAGE_ROLES : GUEST_TICKET_ACCESS_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const ticketId = requireUuid(c.req.param("ticketId"), "ticketId");
    const repo = repoOf(c);
    const ticket = await guarded(() => repo.findTicket(propertyId, ticketId));
    if (!ticket) throw Errors.notFound("Ticket no encontrado.");
    const role = (c.get("verticalRole") ?? "") as never;
    if (!actorMayOperateTicket({ role, userId: c.get("userId") }, ticket, GUEST_TICKET_MANAGE_ROLES)) {
      throw Errors.forbidden("Solo puedes operar tickets de tu departamento, asignados a ti, o si eres owner/gm/frontdesk.");
    }
    if (opts.to && !canTransitionTicket(ticket.status, opts.to)) {
      throw Errors.conflict(`El ticket esta ${ticket.status}: no puede pasar a ${opts.to}.`);
    }
    return { repo, propertyId, ticket };
  }

  function respond(c: Context<CoreAuthHonoEnv>, updated: GuestTicketRecord | null) {
    if (!updated) throw Errors.notFound("Ticket no encontrado.");
    return c.json(serializeTicket(updated, clock()));
  }

  app.post("/hoteles/:propertyId/tickets/:ticketId/iniciar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, { to: "en_progreso" });
    return respond(c, await guarded(() => repo.setStatus(propertyId, ticket.id, "en_progreso", null)));
  });

  app.post("/hoteles/:propertyId/tickets/:ticketId/cerrar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, { to: "cerrado" });
    const nota = optionalText((await readBody(c)).nota, "nota", 1000);
    return respond(c, await guarded(() => repo.setStatus(propertyId, ticket.id, "cerrado", nota)));
  });

  app.post("/hoteles/:propertyId/tickets/:ticketId/cancelar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, { to: "cancelado" });
    return respond(c, await guarded(() => repo.setStatus(propertyId, ticket.id, "cancelado", null)));
  });

  app.post("/hoteles/:propertyId/tickets/:ticketId/escalar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, { to: "escalado", managerOnly: true });
    return respond(c, await guarded(() => repo.setStatus(propertyId, ticket.id, "escalado", null)));
  });

  app.post("/hoteles/:propertyId/tickets/:ticketId/asignar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, {});
    const raw = await readBody(c);
    const asignadoA = raw.asignadoA === null ? null : requireUuid(raw.asignadoA, "asignadoA");
    if (asignadoA !== c.get("userId") && !GUEST_TICKET_MANAGE_ROLES.includes((c.get("verticalRole") ?? "") as never)) {
      throw Errors.forbidden("Solo owner/gm/frontdesk asignan un ticket a otra persona.");
    }
    return respond(c, await guarded(() => repo.assignTicket(propertyId, ticket.id, asignadoA)));
  });

  app.post("/hoteles/:propertyId/tickets/:ticketId/reasignar", async (c) => {
    const { repo, propertyId, ticket } = await loadForAction(c, { managerOnly: true });
    const department = oneOf((await readBody(c)).departamento, TICKET_DEPARTMENTS, "departamento") as TicketDepartment;
    return respond(c, await guarded(() => repo.reassignDepartment(propertyId, ticket.id, department)));
  });

  return app;
}
