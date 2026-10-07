// H-26 (migracion 039) -- housekeeping RESIDUAL: configuracion, asignacion automatica, fotos de inspeccion, conteo de
// blancos y opt-out de limpieza. Se REGISTRA sobre la misma app de housekeeping.ts (ver `registerHousekeepingResidualRoutes`)
// para heredar su unica cadena authMiddleware + dbSession + requirePropertyMembership (`/housekeeping/*`): montar otra
// sub-app con su propio middleware abriria dos transacciones por request.
//
// REGLA DURA DE COMPATIBILIDAD: contra una base SIN la migracion 039 las lecturas responden `disponible: false` con
// valores por defecto o listas vacias y las escrituras 503 -- nunca un 500 (el repositorio usa SAVEPOINT).
// Vision artificial de las fotos: NO esta construida (necesita la llave LLM de H-23). La API lo declara con
// `vision: { disponible: false, requiere }`; no se simula ningun analisis ni se gasta nada.
import type { Context, Hono } from "hono";
import { assertVerticalRole } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  HOUSEKEEPING_AUTO_ASSIGN_ROLES,
  HOUSEKEEPING_BOARD_VIEW_ROLES,
  HOUSEKEEPING_CONFIG_ROLES,
  HOUSEKEEPING_TASK_ROLES,
  OPT_OUT_SOURCES,
  PHOTO_MAX_BYTES,
  PHOTO_VISION_STATUS,
  PostgresHousekeepingResidualRepository,
  actorMayOperateTask,
  buildLinenReport,
  decodePhotoBase64,
  isIsoDate,
  parseHousekeepingConfigPatch,
  parseLinenInput,
  planAutoAssignment,
  type CleaningOptOutRecord,
  type HousekeepingConfig,
  type HousekeepingRepository,
  type HousekeepingResidualRepository,
  type LinenReportRow,
  type OptOutSource,
  type TaskPhotoRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Cuerpo maximo de una foto: 1.5 MB en base64 (x4/3) + sobre JSON. */
const PHOTO_BODY_MAX_BYTES = Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 4096;
const SMALL_BODY_MAX_BYTES = 16 * 1024;
/** Fuentes que el STAFF puede declarar al registrar un opt-out: `whatsapp` queda reservada al canal (no conectado aun). */
const STAFF_OPT_OUT_SOURCES: readonly OptOutSource[] = OPT_OUT_SOURCES.filter((s) => s !== "whatsapp");

/** Helpers de housekeeping.ts que estas rutas reutilizan (inyectados para no duplicar ni crear un import circular). */
export interface HousekeepingRouteHelpers {
  hkRepo(c: Context<CoreAuthHonoEnv>): HousekeepingRepository;
  guarded<T>(fn: () => Promise<T>): Promise<T>;
  requireUuid(value: unknown, field: string): string;
  resolveDate(c: Context<CoreAuthHonoEnv>, raw: unknown): Promise<string>;
  optionalText(value: unknown, field: string, max: number): string | null;
  /** Camaristas del selector (miembros `housekeeping` de la property), con degradacion a lista vacia. */
  listCamaristas(c: Context<CoreAuthHonoEnv>): Promise<readonly { readonly id: string; readonly nombre: string }[]>;
}

export function serializeConfig(config: HousekeepingConfig) {
  return {
    personalizada: config.personalizada,
    asignacionAutomatica: config.autoAssignEnabled,
    maxTareasPorCamarista: config.maxTasksPerCamarista,
    minutosJornada: config.shiftMinutes,
    minutosPorTipo: config.minutesByType,
    fotosObligatoriasEnInspeccion: config.photosRequiredOnInspection,
    maxFotosPorTarea: config.maxPhotosPerTask,
    // H-P3-04: hora local a la que el cron arranca el dia (default 7); `horaArranqueDisponible: false` = base sin la migracion 045.
    horaArranque: config.startHour,
    horaArranqueDisponible: config.startHourDisponible,
    actualizadoEn: config.updatedAt,
  };
}

function serializePhoto(p: TaskPhotoRecord) {
  return { id: p.id, tareaId: p.taskId, tipo: p.contentType, bytes: p.byteSize, descripcion: p.caption, tomadaPor: p.takenBy, creadaEn: p.createdAt };
}

function serializeLinenRow(r: LinenReportRow) {
  return {
    articulo: r.item,
    limpias: r.actual?.qtyClean ?? null,
    sucias: r.actual?.qtyDirty ?? null,
    enLavanderia: r.actual?.qtyLaundry ?? null,
    danadas: r.actual?.qtyDamaged ?? null,
    total: r.totalActual,
    contadoPor: r.actual?.countedBy ?? null,
    actualizadoEn: r.actual?.updatedAt ?? null,
    conteoAnterior: r.anterior ? { fecha: r.anterior.countDate, total: r.anterior.total } : null,
    diferencia: r.diferencia,
  };
}

function serializeOptOut(o: CleaningOptOutRecord) {
  return {
    id: o.id, roomId: o.roomId, habitacion: o.roomCode, fecha: o.optOutDate, origen: o.source, nota: o.note, estado: o.status,
    creadoPor: o.createdBy, creadoEn: o.createdAt, revertidoEn: o.revertedAt,
  };
}

export function registerHousekeepingResidualRoutes(app: Hono<CoreAuthHonoEnv>, deps: AppDeps, h: HousekeepingRouteHelpers): void {
  const residual = (c: Context<CoreAuthHonoEnv>): HousekeepingResidualRepository => residualRepoFor(deps, c);

  async function smallBody(c: Context<CoreAuthHonoEnv>): Promise<unknown> {
    return readJsonCapped(c.req.raw, SMALL_BODY_MAX_BYTES);
  }

  // ---- Configuracion ------------------------------------------------------------------------------------

  app.get("/hoteles/:propertyId/housekeeping/configuracion", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const r = await h.guarded(() => residual(c).getConfig(c.req.param("propertyId")));
    return c.json({ disponible: r.disponible, ...serializeConfig(r.config), vision: PHOTO_VISION_STATUS });
  });

  app.put("/hoteles/:propertyId/housekeeping/configuracion", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_CONFIG_ROLES);
    const patch = await h.guarded(async () => parseHousekeepingConfigPatch(await smallBody(c)));
    const saved = await h.guarded(() => residual(c).saveConfig(c.req.param("propertyId"), patch, c.get("userId")));
    return c.json({ disponible: true, ...serializeConfig(saved), vision: PHOTO_VISION_STATUS });
  });

  // ---- Asignacion automatica ---------------------------------------------------------------------------

  app.post("/hoteles/:propertyId/housekeeping/asignacion-automatica", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_AUTO_ASSIGN_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await smallBody(c);
    const fecha = await h.resolveDate(c, raw && typeof raw === "object" ? (raw as Record<string, unknown>).fecha : undefined);
    const cfg = await h.guarded(() => residual(c).getConfig(propertyId));
    if (!cfg.disponible) throw Errors.serviceUnavailable("La asignacion automatica no esta disponible aun: requiere la migracion 039.");
    if (!cfg.config.autoAssignEnabled) throw Errors.conflict("La asignacion automatica esta apagada: enciendela en la configuracion de housekeeping.");

    const hk = h.hkRepo(c);
    // En SECUENCIA: cada lectura abre su SAVEPOINT sobre la misma sesion del request (en paralelo: 3B001/25P02).
    const tasks = await h.guarded(() => hk.listTasks(propertyId, { workDate: fecha }));
    const camaristas = await h.listCamaristas(c);
    const pending = tasks.filter((t) => t.status === "pendiente" && t.assignedTo === null);
    const loads = camaristas.map((cam) => {
      const own = tasks.filter((t) => t.assignedTo === cam.id && t.status !== "cancelada");
      return { camaristaId: cam.id, tasks: own.length, minutes: own.reduce((sum, t) => sum + cfg.config.minutesByType[t.taskType], 0) };
    });
    const plan = planAutoAssignment(
      pending.map((t) => ({ id: t.id, roomCode: t.roomCode, taskType: t.taskType, priority: t.priority })),
      loads,
      cfg.config,
    );

    const asignaciones: { taskId: string; camaristaId: string }[] = [];
    const sinAsignar = [...plan.unassigned];
    for (const a of plan.assignments) {
      const updated = await h.guarded(() => hk.assignTask(propertyId, a.taskId, a.camaristaId));
      if (updated) asignaciones.push(a);
      else sinAsignar.push(a.taskId);
    }
    // Algo que atender: tareas que no caben en ninguna jornada. Una por propiedad por dia (dedupe en la base).
    if (sinAsignar.length > 0) {
      await emitirNotificacion(c.get("db"), {
        evento: "hoteles.housekeeping.sin_cupo",
        organizationId: c.get("organizationId"),
        propertyId,
        clave: `${propertyId}:${fecha}`,
        parametros: { cantidad: sinAsignar.length },
      });
    }
    return c.json({
      fecha,
      asignadas: asignaciones.length,
      sinAsignar: sinAsignar.length,
      sinCamaristas: camaristas.length === 0,
      asignaciones: asignaciones.map((a) => ({ tareaId: a.taskId, camaristaId: a.camaristaId })),
    });
  });

  // ---- Fotos de inspeccion -----------------------------------------------------------------------------

  async function taskOr404(c: Context<CoreAuthHonoEnv>) {
    const propertyId = c.req.param("propertyId") ?? "";
    const taskId = h.requireUuid(c.req.param("taskId"), "taskId");
    const task = await h.guarded(() => h.hkRepo(c).findTask(propertyId, taskId));
    if (!task) throw Errors.notFound("Tarea de limpieza no encontrada.");
    return task;
  }

  app.get("/hoteles/:propertyId/housekeeping/tareas/:taskId/fotos", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const task = await taskOr404(c);
    // En SECUENCIA: ambos metodos usan SAVEPOINT sobre la misma sesion del request.
    const list = await h.guarded(() => residual(c).listPhotos(task.propertyId, task.id));
    const cfg = await h.guarded(() => residual(c).getConfig(task.propertyId));
    return c.json({ tareaId: task.id, disponible: list.disponible, fotos: list.photos.map(serializePhoto), maximo: cfg.config.maxPhotosPerTask, vision: PHOTO_VISION_STATUS });
  });

  app.post("/hoteles/:propertyId/housekeeping/tareas/:taskId/fotos", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const raw = await readJsonCapped<Record<string, unknown> | null>(c.req.raw, PHOTO_BODY_MAX_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo invalido: se esperaba un objeto.");
    const task = await taskOr404(c);
    if (!actorMayOperateTask(c.get("verticalRole") ?? "", c.get("userId"), task.assignedTo)) {
      throw Errors.forbidden("Solo puedes subir fotos de tareas asignadas a ti o sin asignar.");
    }
    if (task.status === "cancelada") throw Errors.conflict("Una tarea cancelada no recibe fotos.");
    const caption = h.optionalText(raw.descripcion, "descripcion", 200);
    const { bytes, contentType } = await h.guarded(async () => decodePhotoBase64(raw.imagen));
    const cfg = await h.guarded(() => residual(c).getConfig(task.propertyId));
    if ((await h.guarded(() => residual(c).countPhotos(task.propertyId, task.id))) >= cfg.config.maxPhotosPerTask) {
      throw Errors.conflict(`La tarea ya tiene el maximo de fotos (${cfg.config.maxPhotosPerTask}).`);
    }
    const photo = await h.guarded(() => residual(c).addPhoto({ propertyId: task.propertyId, taskId: task.id, contentType, bytes, caption, takenBy: c.get("userId") }));
    return c.json(serializePhoto(photo), 201);
  });

  app.get("/hoteles/:propertyId/housekeeping/tareas/:taskId/fotos/:photoId", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const task = await taskOr404(c);
    const photoId = h.requireUuid(c.req.param("photoId"), "photoId");
    const photo = await h.guarded(() => residual(c).getPhoto(task.propertyId, task.id, photoId));
    if (!photo) throw Errors.notFound("Foto no encontrada.");
    // Contenido de usuario: tipo fijo por firma real, sin sniffing, sin cache compartida y sin poder ejecutar nada.
    return new Response(photo.bytes as unknown as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": photo.contentType,
        "content-length": String(photo.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "content-disposition": "inline",
      },
    });
  });

  app.delete("/hoteles/:propertyId/housekeeping/tareas/:taskId/fotos/:photoId", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const task = await taskOr404(c);
    if (!actorMayOperateTask(c.get("verticalRole") ?? "", c.get("userId"), task.assignedTo)) {
      throw Errors.forbidden("Solo puedes retirar fotos de tareas asignadas a ti o sin asignar.");
    }
    const photoId = h.requireUuid(c.req.param("photoId"), "photoId");
    const removed = await h.guarded(() => residual(c).deletePhoto(task.propertyId, task.id, photoId));
    if (!removed) throw Errors.notFound("Foto no encontrada.");
    return c.json({ ok: true });
  });

  // ---- Conteo de blancos -------------------------------------------------------------------------------

  app.get("/hoteles/:propertyId/housekeeping/blancos", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const fecha = await h.resolveDate(c, c.req.query("fecha"));
    const r = await h.guarded(() => residual(c).listLinen(c.req.param("propertyId"), fecha));
    return c.json({ fecha, disponible: r.disponible, articulos: buildLinenReport(r.current, r.previous).map(serializeLinenRow) });
  });

  app.put("/hoteles/:propertyId/housekeeping/blancos", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const input = await h.guarded(async () => parseLinenInput(await smallBody(c)));
    const saved = await h.guarded(() => residual(c).saveLinen({ ...input, propertyId: c.req.param("propertyId"), countedBy: c.get("userId") }));
    return c.json({
      fecha: saved.countDate, articulo: saved.item, limpias: saved.qtyClean, sucias: saved.qtyDirty, enLavanderia: saved.qtyLaundry,
      danadas: saved.qtyDamaged, actualizadoEn: saved.updatedAt,
    });
  });

  // ---- Opt-out de limpieza -----------------------------------------------------------------------------

  app.get("/hoteles/:propertyId/housekeeping/opt-out", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_BOARD_VIEW_ROLES);
    const fecha = await h.resolveDate(c, c.req.query("fecha"));
    const r = await h.guarded(() => residual(c).listOptOuts(c.req.param("propertyId"), fecha));
    return c.json({ fecha, disponible: r.disponible, optOuts: r.optOuts.map(serializeOptOut) });
  });

  app.post("/hoteles/:propertyId/housekeeping/opt-out", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const parsed = await smallBody(c);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Errors.validation("Cuerpo invalido: se esperaba un objeto.");
    const raw = parsed as Record<string, unknown>;
    const roomId = h.requireUuid(raw.roomId, "roomId");
    const origen = raw.origen === undefined ? "recepcion" : raw.origen;
    if (!(STAFF_OPT_OUT_SOURCES as readonly unknown[]).includes(origen)) throw Errors.validation(`origen: se esperaba ${STAFF_OPT_OUT_SOURCES.join("|")}.`);
    const fechaRaw = raw.fecha;
    if (fechaRaw !== undefined && !isIsoDate(fechaRaw)) throw Errors.validation("fecha: formato esperado YYYY-MM-DD.");
    const fecha = await h.resolveDate(c, fechaRaw);
    const result = await h.guarded(() =>
      residual(c).registerOptOut({
        propertyId: c.req.param("propertyId"),
        roomId,
        optOutDate: fecha,
        source: origen as OptOutSource,
        note: h.optionalText(raw.nota, "nota", 200),
        createdBy: c.get("userId"),
      }),
    );
    return c.json({ ...serializeOptOut(result.optOut), tareasCanceladas: result.tareasCanceladas }, 201);
  });

  app.post("/hoteles/:propertyId/housekeeping/opt-out/:id/revertir", async (c) => {
    assertVerticalRole(c, HOUSEKEEPING_TASK_ROLES);
    const id = h.requireUuid(c.req.param("id"), "id");
    const reverted = await h.guarded(() => residual(c).revertOptOut(c.req.param("propertyId"), id, c.get("userId")));
    if (!reverted) throw Errors.notFound("Opt-out activo no encontrado.");
    return c.json(serializeOptOut(reverted));
  });
}

/** Fabrica del repositorio residual por request (la usa tambien housekeeping.ts para sus propias consultas). */
export function residualRepoFor(deps: AppDeps, c: Context<CoreAuthHonoEnv>): HousekeepingResidualRepository {
  const db = c.get("db");
  return deps.hotelesHousekeepingResidualRepo ? deps.hotelesHousekeepingResidualRepo(db) : new PostgresHousekeepingResidualRepository(db);
}
