// H-04 (migracion 033) EXTIENDE este archivo con el housekeeping completo (tablero, tareas,
// inspeccion, fuera de servicio, reporte diario): ver el bloque "H-04" al final. Lo de abajo
// es el alcance original de la Fase 6:
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
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  HK_PRIORITIES,
  HK_TASK_STATUSES,
  HK_TASK_TYPES,
  HOUSEKEEPING_BOARD_VIEW_ROLES,
  HOUSEKEEPING_SHIFT_PUBLISH_ROLES,
  HOUSEKEEPING_TASK_ROLES,
  HousekeepingAccessDeniedError,
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  OUT_OF_SERVICE_KINDS,
  PostgresHousekeepingRepository,
  ROOM_OUT_OF_SERVICE_ROLES,
  actorMayOperateTask,
  assertTaskAction,
  inspectorIsAllowed,
  isIsoDate,
  optOutSkipsTaskType,
  type HousekeepingPriority,
  type HousekeepingRepository,
  type HousekeepingTaskRecord,
  type HousekeepingTaskStatus,
  type HousekeepingTaskType,
  type OutOfServiceKind,
  type OutOfServiceRecord,
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
import { registerHousekeepingResidualRoutes, residualRepoFor } from "./housekeeping-residual.ts";
import { emitirNotificacion } from "@atiende/db";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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


// ---- H-04: housekeeping completo (tablero, tareas, inspeccion, fuera de servicio, reporte) ----

function serializeTask(t: HousekeepingTaskRecord) {
  return {
    id: t.id,
    roomId: t.roomId,
    habitacion: t.roomCode,
    tipo: t.taskType,
    estado: t.status,
    prioridad: t.priority,
    fecha: t.workDate,
    asignadoA: t.assignedTo,
    notas: t.notes,
    iniciadaEn: t.startedAt,
    terminadaEn: t.finishedAt,
    resultadoInspeccion: t.inspectionResult,
    inspeccionadaPor: t.inspectedBy,
    inspeccionadaEn: t.inspectedAt,
    notaInspeccion: t.inspectionNote,
    rechazos: t.rejections,
    creadoEn: t.createdAt,
    actualizadoEn: t.updatedAt,
  };
}

function serializeOutOfService(o: OutOfServiceRecord) {
  return {
    id: o.id,
    roomId: o.roomId,
    habitacion: o.roomCode,
    tipo: o.kind,
    motivo: o.reason,
    desde: o.fromDate,
    regresoEstimado: o.expectedReturnDate,
    estado: o.status,
    ticketMantenimientoId: o.maintenanceTicketId,
    creadoEn: o.createdAt,
    cerradoEn: o.closedAt,
  };
}

/** Traduce los errores de dominio del housekeeping a respuestas HTTP (nunca un 500 crudo). */
function toApiError(err: unknown): unknown {
  if (err instanceof HousekeepingUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof HousekeepingNotFoundError) return Errors.notFound(err.message);
  if (err instanceof HousekeepingConflictError) return Errors.conflict(err.message);
  if (err instanceof HousekeepingInvalidInputError) return Errors.validation(err.message);
  if (err instanceof HousekeepingAccessDeniedError) return Errors.forbidden(err.message);
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

function parseOptionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isIsoDate(value)) throw Errors.validation(`${field}: formato esperado YYYY-MM-DD.`);
  return value;
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

  // ---- H-04: housekeeping completo ----------------------------------------------------
  // Mismo montaje que arriba (authMiddleware + dbSession + requirePropertyMembership ya
  // cubren `/housekeeping/*`). REGLA DURA DE COMPATIBILIDAD: contra una base sin la
  // migracion 033 las lecturas degradan (tablero solo-estado, listas vacias,
  // `tareasDisponibles: false`) y las escrituras responden 503 -- nunca un 500.

  function hkRepo(c: Context<CoreAuthHonoEnv>): HousekeepingRepository {
    const db = c.get("db");
    return deps.hotelesHousekeepingRepo ? deps.hotelesHousekeepingRepo(db) : new PostgresHousekeepingRepository(db);
  }

  async function resolveDate(c: Context<CoreAuthHonoEnv>, raw: unknown): Promise<string> {
    const explicit = parseOptionalDate(raw, "fecha");
    if (explicit) return explicit;
    const tz = await deps.hotelesRepo(c.get("db")).findPropertyTimezone(c.req.param("propertyId") ?? "");
    return hoyFechaNegocio(resolverZonaHorariaNegocio(tz));
  }

  async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await c.req.json().catch(() => ({}));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  app.get("/hoteles/:propertyId/housekeeping/tablero", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const fecha = await resolveDate(c, c.req.query("fecha"));
    const board = await guarded(() => hkRepo(c).getBoard(c.req.param("propertyId"), fecha));
    return c.json({
      fecha,
      tareasDisponibles: board.tareasDisponibles,
      habitaciones: board.rows.map((r) => ({
        roomId: r.roomId,
        codigo: r.code,
        tipoHabitacion: r.roomType,
        estado: r.roomStatus,
        tarea: r.task ? { id: r.task.id, tipo: r.task.taskType, estado: r.task.status, prioridad: r.task.priority, asignadoA: r.task.assignedTo, rechazos: r.task.rejections } : null,
        fueraDeServicio: r.outOfService
          ? { id: r.outOfService.id, tipo: r.outOfService.kind, motivo: r.outOfService.reason, regresoEstimado: r.outOfService.expectedReturnDate }
          : null,
      })),
    });
  });

  app.get("/hoteles/:propertyId/housekeeping/reporte", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const fecha = await resolveDate(c, c.req.query("fecha"));
    const r = await guarded(() => hkRepo(c).dailyReport(c.req.param("propertyId"), fecha));
    return c.json({
      fecha: r.workDate,
      tareasDisponibles: r.tareasDisponibles,
      totales: r.totales,
      porResponsable: r.porResponsable,
      habitacionesPorEstado: r.habitacionesPorEstado,
      fueraDeServicioActivas: r.fueraDeServicioActivas,
    });
  });

  // Selector de responsables: miembros aceptados con rol `housekeeping` que cubren esta
  // property. Lectura best-effort con SAVEPOINT (la funcion SQL vive en la sesion REAL del
  // request): si falla por migracion pendiente degrada a lista vacia, nunca a 500/25P02.
  async function listCamaristas(c: Context<CoreAuthHonoEnv>): Promise<readonly { readonly id: string; readonly nombre: string }[]> {
    const propertyId = c.req.param("propertyId") ?? "";
    const organizationId = c.get("organizationId");
    const members = await runWithSavepointFallback({
      session: c.get("db"),
      primary: () => deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(organizationId, "housekeeping"),
      isRecoverable: isMigrationPendingError,
      fallback: () => Promise.resolve([]),
    });
    return members.filter((m) => m.propertyIds === null || m.propertyIds.includes(propertyId)).map((m) => ({ id: m.userId, nombre: m.fullName }));
  }

  app.get("/hoteles/:propertyId/housekeeping/camaristas", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    return c.json({ camaristas: await listCamaristas(c) });
  });

  app.get("/hoteles/:propertyId/housekeeping/tareas", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const fecha = await resolveDate(c, c.req.query("fecha"));
    const estado = c.req.query("estado");
    if (estado !== undefined && !HK_TASK_STATUSES.includes(estado as HousekeepingTaskStatus)) {
      throw Errors.validation(`estado: se esperaba ${HK_TASK_STATUSES.join("|")}.`);
    }
    const asignadoA = c.req.query("asignadoA");
    const tasks = await guarded(() =>
      hkRepo(c).listTasks(c.req.param("propertyId"), {
        workDate: fecha,
        ...(estado ? { status: estado as HousekeepingTaskStatus } : {}),
        ...(asignadoA ? { assignedTo: requireUuid(asignadoA, "asignadoA") } : {}),
      }),
    );
    return c.json({ fecha, tareas: tasks.map(serializeTask) });
  });

  app.post("/hoteles/:propertyId/housekeeping/tareas/generar", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const raw = await readBody(c);
    const fecha = await resolveDate(c, raw.fecha);
    const propertyId = c.req.param("propertyId");
    // H-26: habitaciones con opt-out de limpieza activo ese dia no reciben tarea de estancia (la de salida si). Contra la
    // base sin 039 la lectura degrada a vacio (SAVEPOINT) y el comportamiento es el de antes.
    const optOuts = await guarded(() => residualRepoFor(deps, c).listOptOuts(propertyId, fecha));
    const skipStay = optOuts.optOuts.filter((o) => o.status === "activo").map((o) => o.roomId);
    const creadas = await guarded(() => hkRepo(c).generateDay(propertyId, fecha, c.get("userId"), skipStay));
    return c.json({ fecha, creadas }, 201);
  });

  app.post("/hoteles/:propertyId/housekeeping/tareas", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const raw = await readBody(c);
    const roomId = requireUuid(raw.roomId, "roomId");
    const tipo = raw.tipo === undefined ? "salida" : raw.tipo;
    if (!HK_TASK_TYPES.includes(tipo as HousekeepingTaskType)) throw Errors.validation(`tipo: se esperaba ${HK_TASK_TYPES.join("|")}.`);
    const prioridad = raw.prioridad === undefined ? "normal" : raw.prioridad;
    if (!HK_PRIORITIES.includes(prioridad as HousekeepingPriority)) throw Errors.validation(`prioridad: se esperaba ${HK_PRIORITIES.join("|")}.`);
    const asignadoA = raw.asignadoA === undefined || raw.asignadoA === null ? null : requireUuid(raw.asignadoA, "asignadoA");
    const fecha = await resolveDate(c, raw.fecha);
    if (optOutSkipsTaskType(tipo as HousekeepingTaskType) && (await guarded(() => residualRepoFor(deps, c).hasActiveOptOut(c.req.param("propertyId"), roomId, fecha)))) {
      throw Errors.conflict("La habitacion tiene un opt-out de limpieza activo ese dia: no se crean tareas de estancia ni repaso.");
    }
    const created = await guarded(() =>
      hkRepo(c).createTask({
        propertyId: c.req.param("propertyId"),
        roomId,
        taskType: tipo as HousekeepingTaskType,
        priority: prioridad as HousekeepingPriority,
        workDate: fecha,
        assignedTo: asignadoA,
        notes: optionalText(raw.notas, "notas", 500),
        createdBy: c.get("userId"),
      }),
    );
    return c.json(serializeTask(created), 201);
  });

  // Transiciones de una tarea. Cada una: rol -> existe (404) -> el actor puede operar ESA
  // tarea -> la transicion es valida (409) -> UPDATE con guarda de estado (carrera perdida = 409).
  async function transition(
    c: Context<CoreAuthHonoEnv>,
    action: "iniciar" | "terminar" | "inspeccionar" | "asignar" | "cancelar",
    run: (repo: HousekeepingRepository, task: HousekeepingTaskRecord, body: Record<string, unknown>) => Promise<HousekeepingTaskRecord | null>,
  ) {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const taskId = requireUuid(c.req.param("taskId"), "taskId");
    const body = await readBody(c);
    const repo = hkRepo(c);
    const task = await guarded(() => repo.findTask(propertyId, taskId));
    if (!task) throw Errors.notFound("Tarea de limpieza no encontrada.");
    if (!actorMayOperateTask(c.get("verticalRole") ?? "", c.get("userId"), task.assignedTo)) {
      throw Errors.forbidden("Solo puedes operar tareas asignadas a ti o sin asignar.");
    }
    try {
      assertTaskAction(task.status, action);
    } catch (err) {
      throw toApiError(err);
    }
    const updated = await guarded(() => run(repo, task, body));
    if (!updated) throw Errors.conflict("La tarea cambio de estado mientras la operabas; recarga el tablero.");
    return c.json(serializeTask(updated));
  }

  // Inspeccion (H-26): si la property exige fotos, aprobar requiere al menos una foto de la tarea; rechazar avisa al supervisor.
  // Contra la base sin 039 la config es la de por defecto (fotos no obligatorias) y ambas lecturas degradan con SAVEPOINT.
  async function inspect(c: Context<CoreAuthHonoEnv>, repo: HousekeepingRepository, task: HousekeepingTaskRecord, approved: boolean, note: string | null) {
    const residual = residualRepoFor(deps, c);
    if (approved) {
      const { config } = await residual.getConfig(task.propertyId);
      if (config.photosRequiredOnInspection && (await residual.countPhotos(task.propertyId, task.id)) === 0) {
        throw Errors.conflict("Esta property exige al menos una foto de la tarea para aprobar la inspeccion.");
      }
    }
    const updated = await repo.inspectTask(task.propertyId, task.id, { inspectorId: c.get("userId"), approved, note });
    if (updated && !approved) {
      await emitirNotificacion(c.get("db"), {
        evento: "hoteles.housekeeping.inspeccion_rechazada",
        organizationId: c.get("organizationId"),
        propertyId: task.propertyId,
        clave: `${task.id}:${updated.rejections}`,
        entidadTipo: "housekeeping_task",
        entidadId: task.id,
      });
    }
    return updated;
  }

  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/iniciar", (c) =>
    transition(c, "iniciar", (repo, task) => repo.startTask(task.propertyId, task.id, c.get("userId"))),
  );
  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/terminar", (c) =>
    transition(c, "terminar", (repo, task) => repo.finishTask(task.propertyId, task.id)),
  );
  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/inspeccionar", (c) =>
    transition(c, "inspeccionar", (repo, task, body) => {
      if (typeof body.aprobada !== "boolean") throw Errors.validation("aprobada: requerido, booleano.");
      const nota = optionalText(body.nota, "nota", 500);
      if (!body.aprobada && !nota) throw Errors.validation("nota: obligatoria al rechazar una inspeccion (que debe corregirse).");
      // Separacion de funciones (espejo del CHECK de la migracion 033).
      if (!inspectorIsAllowed(c.get("userId"), task.assignedTo)) throw Errors.forbidden("Quien limpio no puede inspeccionar su propio trabajo.");
      return inspect(c, repo, task, body.aprobada, nota);
    }),
  );
  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/asignar", (c) =>
    transition(c, "asignar", (repo, task, body) => repo.assignTask(task.propertyId, task.id, requireUuid(body.asignadoA, "asignadoA"))),
  );
  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/cancelar", (c) =>
    transition(c, "cancelar", (repo, task) => repo.cancelTask(task.propertyId, task.id)),
  );

  // Marcar una habitacion sucia (p. ej. tras un check-out o una incidencia).
  app.post("/hoteles/:propertyId/housekeeping/habitaciones/:roomId/sucia", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const propertyId = c.req.param("propertyId");
    const roomId = requireUuid(c.req.param("roomId"), "roomId");
    const repo = hkRepo(c);
    const room = await guarded(() => repo.findRoom(propertyId, roomId));
    if (!room) throw Errors.notFound("Habitacion no encontrada.");
    const status = await guarded(() => repo.markRoomDirty(propertyId, roomId));
    if (!status) throw Errors.conflict(`La habitacion esta en estado "${room.status}": solo una habitacion disponible u ocupada se marca sucia.`);
    return c.json({ roomId, estado: status });
  });

  // ---- Fuera de servicio / fuera de orden ----

  app.get("/hoteles/:propertyId/housekeeping/fuera-de-servicio", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const soloActivas = c.req.query("soloActivas") !== "false";
    const rows = await guarded(() => hkRepo(c).listOutOfService(c.req.param("propertyId"), soloActivas));
    return c.json({ fueraDeServicio: rows.map(serializeOutOfService) });
  });

  app.post("/hoteles/:propertyId/housekeeping/fuera-de-servicio", async (c) => {
    assertVerticalRole(c, ROOM_OUT_OF_SERVICE_ROLES);
    const raw = await readBody(c);
    const roomId = requireUuid(raw.roomId, "roomId");
    const tipo = raw.tipo === undefined ? "fuera_de_servicio" : raw.tipo;
    if (!OUT_OF_SERVICE_KINDS.includes(tipo as OutOfServiceKind)) throw Errors.validation(`tipo: se esperaba ${OUT_OF_SERVICE_KINDS.join("|")}.`);
    const motivo = typeof raw.motivo === "string" ? raw.motivo.trim() : "";
    if (motivo.length < 3 || motivo.length > 300) throw Errors.validation("motivo: requerido, entre 3 y 300 caracteres.");
    const desde = parseOptionalDate(raw.desde, "desde") ?? (await resolveDate(c, undefined));
    const regreso = parseOptionalDate(raw.regresoEstimado, "regresoEstimado");
    if (regreso && regreso < desde) throw Errors.validation("regresoEstimado: no puede ser anterior a desde.");
    const ticketId = raw.ticketMantenimientoId === undefined || raw.ticketMantenimientoId === null ? null : requireUuid(raw.ticketMantenimientoId, "ticketMantenimientoId");
    const created = await guarded(() =>
      hkRepo(c).setOutOfService({
        propertyId: c.req.param("propertyId"),
        roomId,
        kind: tipo as OutOfServiceKind,
        reason: motivo,
        fromDate: desde,
        expectedReturnDate: regreso,
        maintenanceTicketId: ticketId,
        createdBy: c.get("userId"),
      }),
    );
    return c.json(serializeOutOfService(created), 201);
  });

  app.post("/hoteles/:propertyId/housekeeping/fuera-de-servicio/:id/rehabilitar", async (c) => {
    assertVerticalRole(c, ROOM_OUT_OF_SERVICE_ROLES);
    const id = requireUuid(c.req.param("id"), "id");
    const closed = await guarded(() => hkRepo(c).returnToService(c.req.param("propertyId"), id, c.get("userId")));
    if (!closed) throw Errors.notFound("Inhabilitacion activa no encontrada.");
    return c.json(serializeOutOfService(closed));
  });

  // H-26 (migracion 039): config, asignacion automatica, fotos, blancos y opt-out sobre esta misma cadena de middleware.
  registerHousekeepingResidualRoutes(app, deps, { hkRepo, guarded, requireUuid, resolveDate, optionalText, listCamaristas });

  return app;
}
