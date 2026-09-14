// Fase 6 hoteles (REQ-HK-008/011) — housekeeping ACOTADO a lo que domain-hoteles
// porta en esta fase: turnos de camaristas/lavandería (validados contra la LFT) +
// tickets de mantenimiento correctivo. Mismo patrón de montaje que
// folios.ts/reservas.ts: authMiddleware + dbSession + requirePropertyMembership
// ("propertyId"), filtrado fino con assertVerticalRole dentro de cada handler.
//
// Explícitamente FUERA de esta fase (dependen de un conector PMS real, REQ-INT-001,
// que ninguna vertical de fusion tiene todavía): asignación automática de camaristas
// (optimizador CP-SAT) e inspección de habitación por foto/OCR -- `assignedTo` de un
// ticket de mantenimiento es manual (PATCH de un supervisor), no expuesto todavía
// como ruta separada porque el encargo de esta fase es crear/listar/cerrar, no un
// tablero de asignación completo.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  HOUSEKEEPING_SHIFT_PUBLISH_ROLES,
  MAINTENANCE_TICKET_CREATE_ROLES,
  MAINTENANCE_TICKET_MANAGE_ROLES,
  TurnosLftViolationError,
  assertTurnosLftPublishable,
  validateTurnosLft,
  type HousekeepingShiftRecord,
  type MaintenanceTicketOrigin,
  type MaintenanceTicketRecord,
  type MaintenanceTicketSeverity,
  type MaintenanceTicketStatus,
  type ProposedShift,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2\d):([0-5]\d)$/;
const TICKET_SEVERITIES: readonly MaintenanceTicketSeverity[] = ["alta", "media", "baja"];
const TICKET_ORIGINS: readonly MaintenanceTicketOrigin[] = ["huesped", "staff", "agente", "sensor"];
const TICKET_STATUSES: readonly MaintenanceTicketStatus[] = ["abierto", "en_progreso", "cerrado", "cancelado"];

function serializeTicket(t: MaintenanceTicketRecord) {
  return {
    id: t.id,
    roomId: t.roomId,
    titulo: t.title,
    descripcion: t.description,
    origen: t.origin,
    severidad: t.severity,
    estado: t.status,
    asignadoA: t.assignedTo,
    costoEstimado: t.estimatedCost,
    costoReal: t.actualCost,
    notaResolucion: t.resolutionNote,
    creadoPor: t.createdBy,
    cerradoEn: t.closedAt,
    creadoEn: t.createdAt,
    actualizadoEn: t.updatedAt,
  };
}

function serializeShift(s: HousekeepingShiftRecord) {
  return { id: s.id, staffId: s.staffId, fecha: s.workDate, inicio: s.startTime, fin: s.endTime };
}

export function hotelesHousekeepingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/mantenimiento/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/mantenimiento", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/housekeeping/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/housekeeping/turnos", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- REQ-HK-011: tickets de mantenimiento (crear/listar/cerrar) ----

  interface CreateTicketBody {
    readonly roomId?: unknown;
    readonly titulo?: unknown;
    readonly descripcion?: unknown;
    readonly origen?: unknown;
    readonly severidad?: unknown;
    readonly costoEstimado?: unknown;
  }

  app.post("/hoteles/:propertyId/mantenimiento/tickets", async (c) => {
    assertVerticalRole(c, MAINTENANCE_TICKET_CREATE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId");
    const repo = deps.hotelesRepo(c.get("db"));
    const raw = (await c.req.json().catch(() => ({}))) as CreateTicketBody;

    const title = typeof raw.titulo === "string" ? raw.titulo.trim() : "";
    const description = typeof raw.descripcion === "string" ? raw.descripcion.trim() : "";
    if (!title || title.length > 150) throw Errors.validation("titulo: requerido, máximo 150 caracteres.");
    if (!description || description.length > 1000) throw Errors.validation("descripcion: requerida, máximo 1000 caracteres.");
    const origin = TICKET_ORIGINS.includes(raw.origen as MaintenanceTicketOrigin) ? (raw.origen as MaintenanceTicketOrigin) : "staff";
    const severity = TICKET_SEVERITIES.includes(raw.severidad as MaintenanceTicketSeverity) ? (raw.severidad as MaintenanceTicketSeverity) : "media";
    const estimatedCost = typeof raw.costoEstimado === "number" && Number.isFinite(raw.costoEstimado) && raw.costoEstimado >= 0 ? raw.costoEstimado : 0;
    const roomId = typeof raw.roomId === "string" && raw.roomId.trim() ? raw.roomId.trim() : null;

    const ticket = await repo.insertMaintenanceTicket({
      organizationId,
      propertyId,
      roomId,
      title,
      description,
      origin,
      severity,
      estimatedCost,
      createdBy: userId,
    });
    return c.json(serializeTicket(ticket), 201);
  });

  app.get("/hoteles/:propertyId/mantenimiento/tickets", async (c) => {
    assertVerticalRole(c, MAINTENANCE_TICKET_CREATE_ROLES);
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado");
    if (estado !== undefined && !TICKET_STATUSES.includes(estado as MaintenanceTicketStatus)) {
      throw Errors.validation("estado: se esperaba abierto|en_progreso|cerrado|cancelado.");
    }
    const repo = deps.hotelesRepo(c.get("db"));
    const tickets = await repo.listMaintenanceTickets(propertyId, estado ? { status: estado as MaintenanceTicketStatus } : undefined);
    return c.json(tickets.map(serializeTicket));
  });

  app.get("/hoteles/:propertyId/mantenimiento/tickets/:ticketId", async (c) => {
    assertVerticalRole(c, MAINTENANCE_TICKET_CREATE_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const ticket = await repo.findMaintenanceTicket(c.req.param("propertyId"), c.req.param("ticketId"));
    if (!ticket) throw Errors.notFound("Ticket de mantenimiento no encontrado.");
    return c.json(serializeTicket(ticket));
  });

  app.post("/hoteles/:propertyId/mantenimiento/tickets/:ticketId/cerrar", async (c) => {
    // Solo owner/gm/el técnico de mantenimiento asignado -- NUNCA housekeeping ni
    // frontdesk cambian el costo real de un ticket (mismo criterio adversarial que el
    // origen, ver MAINTENANCE_TICKET_MANAGE_ROLES, domain-hoteles/src/roles.ts).
    assertVerticalRole(c, MAINTENANCE_TICKET_MANAGE_ROLES);
    const propertyId = c.req.param("propertyId");
    const ticketId = c.req.param("ticketId");
    const raw = (await c.req.json().catch(() => ({}))) as { actualCost?: unknown; notaResolucion?: unknown };
    const actualCost = typeof raw.actualCost === "number" && Number.isFinite(raw.actualCost) && raw.actualCost >= 0 ? raw.actualCost : null;
    if (actualCost === null) throw Errors.validation("actualCost: requerido, número >= 0 (el costo real verificado del cierre).");
    const resolutionNote = typeof raw.notaResolucion === "string" && raw.notaResolucion.trim() ? raw.notaResolucion.trim() : null;

    const repo = deps.hotelesRepo(c.get("db"));
    const closed = await repo.closeMaintenanceTicket(propertyId, ticketId, { actualCost, resolutionNote });
    if (!closed) throw Errors.notFound("Ticket de mantenimiento no encontrado o ya estaba cerrado/cancelado.");
    return c.json(serializeTicket(closed));
  });

  // ---- REQ-HK-008: turnos de camaristas/lavandería (LFT) ----

  interface PublishShiftsBody {
    readonly staffId?: unknown;
    readonly fromDate?: unknown;
    readonly toDate?: unknown;
    readonly shifts?: unknown;
  }
  interface RawShift {
    readonly workDate?: unknown;
    readonly startTime?: unknown;
    readonly endTime?: unknown;
  }

  // Puerta de publicación (REQ-HK-008): la plantilla propuesta se valida contra la
  // LFT ANTES de tocar la base -- un intento inválido nunca persiste ni un solo turno
  // (assertTurnosLftPublishable lanza TurnosLftViolationError con TODAS las
  // violaciones, nunca publica parcialmente).
  app.post("/hoteles/:propertyId/housekeeping/turnos", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_SHIFT_PUBLISH_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = (await c.req.json().catch(() => ({}))) as PublishShiftsBody;

    const staffId = typeof raw.staffId === "string" ? raw.staffId.trim() : "";
    if (!staffId) throw Errors.validation("staffId: requerido.");
    const fromDate = typeof raw.fromDate === "string" ? raw.fromDate : "";
    const toDate = typeof raw.toDate === "string" ? raw.toDate : "";
    if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) {
      throw Errors.validation("fromDate/toDate: formato esperado YYYY-MM-DD, fromDate <= toDate.");
    }
    if (!Array.isArray(raw.shifts)) throw Errors.validation("shifts: se esperaba un arreglo.");

    const shifts: { workDate: string; startTime: string; endTime: string }[] = [];
    for (const item of raw.shifts as RawShift[]) {
      const workDate = typeof item.workDate === "string" ? item.workDate : "";
      const startTime = typeof item.startTime === "string" ? item.startTime : "";
      const endTime = typeof item.endTime === "string" ? item.endTime : "";
      if (!DATE_RE.test(workDate) || workDate < fromDate || workDate > toDate) {
        throw Errors.validation(`shifts[].workDate: "${String(item.workDate)}" fuera de rango o mal formado.`);
      }
      if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
        throw Errors.validation("shifts[].startTime/endTime: formato esperado HH:mm.");
      }
      shifts.push({ workDate, startTime, endTime });
    }

    const proposedShifts: ProposedShift[] = shifts.map((s) => ({ staffId, ...s }));
    try {
      assertTurnosLftPublishable({ shifts: proposedShifts });
    } catch (err) {
      if (err instanceof TurnosLftViolationError) {
        return c.json({ ok: false, publicado: false, violaciones: err.violations }, 422);
      }
      throw err;
    }

    const repo = deps.hotelesRepo(c.get("db"));
    const created = await repo.replaceHousekeepingShifts(
      propertyId,
      staffId,
      fromDate,
      toDate,
      shifts.map((s) => ({ organizationId, propertyId, staffId, ...s })),
    );
    return c.json({ ok: true, publicado: true, violaciones: [], turnos: created.map(serializeShift) }, 201);
  });

  // Consulta de cumplimiento: cualquier miembro del staff de la property puede ver el
  // turno YA publicado (transparencia hacia la propia camarista sobre su propio
  // horario) y su cumplimiento recalculado -- defensa en profundidad si un turno
  // llegó a la base por otro medio (seed/migración manual) sin pasar por el POST de
  // arriba, nunca confiado a ciegas solo porque ya está persistido.
  app.get("/hoteles/:propertyId/housekeeping/turnos", async (c) => {
    const propertyId = c.req.param("propertyId");
    const fromDate = c.req.query("desde");
    const toDate = c.req.query("hasta");
    const staffId = c.req.query("staffId");
    if (!fromDate || !toDate || !DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) {
      throw Errors.validation("desde/hasta: requeridos, formato YYYY-MM-DD, desde <= hasta.");
    }

    const repo = deps.hotelesRepo(c.get("db"));
    const shifts = await repo.listHousekeepingShifts(propertyId, fromDate, toDate, staffId || undefined);
    const proposedShifts: ProposedShift[] = shifts.map((s) => ({ staffId: s.staffId, workDate: s.workDate, startTime: s.startTime, endTime: s.endTime }));
    const cumplimiento = validateTurnosLft({ shifts: proposedShifts });

    return c.json({ turnos: shifts.map(serializeShift), cumplimiento: { valido: cumplimiento.valid, violaciones: cumplimiento.violations } });
  });

  return app;
}
