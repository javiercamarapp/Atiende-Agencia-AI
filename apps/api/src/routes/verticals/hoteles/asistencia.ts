// Fase 8 hoteles (REQ-BO-024, P0/GOB, LFT art.132 fr.XXXIV) — checador de asistencia
// INALTERABLE, cruzado contra el horario programado, exportable a la STPS. Mismo
// patrón de montaje que housekeeping.ts/night-audit.ts: authMiddleware + dbSession +
// requirePropertyMembership("propertyId"), filtrado fino con assertVerticalRole
// dentro de cada handler (excepto /checar: fichar el PROPIO registro no tiene lista
// de roles, ver ATTENDANCE_ADMIN_ROLES/roles.ts).
//
// Invariante de autoservicio (REQ-BO-024, checador de autoservicio): esta ruta NUNCA
// lee un `staffUserId` del body de /checar -- el registro SIEMPRE se ficha a nombre
// de `c.get("userId")`, el actor autenticado de la sesión. Reforzado además por RLS
// (`with check (staff_user_id = auth.uid())`, migrations/010_checador_asistencia.sql)
// para que ni un bug futuro de esta ruta pueda fichar a nombre de otro empleado.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ATTENDANCE_ADMIN_ROLES,
  buildStpsAttendanceCsv,
  crossCheckAttendance,
  type AttendanceEventRecord,
  type AttendanceEventType,
  type AttendanceCrossCheckResult,
  type HotelesRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPES: readonly AttendanceEventType[] = ["entrada", "salida"];

function serializeEvent(e: AttendanceEventRecord) {
  return {
    id: e.id,
    staffUserId: e.staffUserId,
    eventType: e.eventType,
    recordedAt: e.recordedAt,
    source: e.source,
    nota: e.note,
  };
}

function serializeCrossCheck(workDate: string, r: AttendanceCrossCheckResult) {
  return {
    fecha: workDate,
    estado: r.status,
    horarioInicio: r.scheduledStart,
    horarioFin: r.scheduledEnd,
    horasProgramadas: r.scheduledMinutes == null ? null : Number((r.scheduledMinutes / 60).toFixed(2)),
    horasTrabajadas: Number((r.workedMinutes / 60).toFixed(2)),
    horasExtra: Number((r.overtimeMinutes / 60).toFixed(2)),
    horasExtraAutorizadas: Number((r.authorizedOvertimeMinutes / 60).toFixed(2)),
    horasExtraNoAutorizadas: Number((r.unauthorizedOvertimeMinutes / 60).toFixed(2)),
    alerta: r.alert,
    anomalias: r.anomalies,
  };
}

/** YYYY-MM-DD..YYYY-MM-DD inclusive, sin librería de fechas -- mismo criterio simple
 *  que housekeeping.ts para iterar un rango corto de días de negocio. */
function* eachDate(fromDate: string, toDate: string): Generator<string> {
  let cursor = fromDate;
  while (cursor <= toDate) {
    yield cursor;
    const d = new Date(`${cursor}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
}

/** Cruza, día por día del rango, lo trabajado (attendance_log) contra lo programado
 *  (staff_schedule) -- el corazón HTTP de REQ-BO-024, reutilizado por /cruce y
 *  /exportar-stps para que ambas rutas cuenten exactamente la misma historia. */
async function computeCrossCheckRows(
  repo: HotelesRepository,
  propertyId: string,
  staffUserId: string,
  fromDate: string,
  toDate: string,
): Promise<{ workDate: string; result: AttendanceCrossCheckResult }[]> {
  const rows: { workDate: string; result: AttendanceCrossCheckResult }[] = [];
  for (const workDate of eachDate(fromDate, toDate)) {
    const [schedule, events] = await Promise.all([
      repo.findStaffSchedule(propertyId, staffUserId, workDate),
      repo.listAttendanceEvents(propertyId, staffUserId, { fromDate: workDate, toDate: workDate }),
    ]);
    const result = crossCheckAttendance({
      schedule: schedule
        ? {
            scheduledStart: schedule.scheduledStart,
            scheduledEnd: schedule.scheduledEnd,
            authorizedOvertimeMinutes: schedule.authorizedOvertimeMinutes,
          }
        : null,
      events: events.map((e) => ({ eventType: e.eventType, recordedAt: e.recordedAt })),
    });
    rows.push({ workDate, result });
  }
  return rows;
}

/** Nota: NO extrae `propertyId` de `c` -- `c.req.param("propertyId")` solo queda
 *  tipado como `string` (no `string | undefined`) cuando Hono conoce el patrón de
 *  ruta exacto en el sitio de la llamada (`app.get("/hoteles/:propertyId/...")`), no
 *  a través de un `Context<CoreAuthHonoEnv>` genérico como el de este helper -- cada
 *  handler lo lee por su cuenta, mismo criterio que `resolver()` en fraude.ts. */
function parseCrossCheckQuery(c: Context<CoreAuthHonoEnv>): { staffUserId: string; fromDate: string; toDate: string } {
  const staffUserId = c.req.query("staffUserId");
  const fromDate = c.req.query("desde");
  const toDate = c.req.query("hasta");
  if (!staffUserId) throw Errors.validation("staffUserId: requerido.");
  if (!fromDate || !toDate || !DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) {
    throw Errors.validation("desde/hasta: requeridos, formato YYYY-MM-DD, desde <= hasta.");
  }
  return { staffUserId, fromDate, toDate };
}

/** Hallazgo de seguridad (revisión real de PR #149, Fase 3 caller-binding): `/cruce`
 *  y `/exportar-stps` reciben `staffUserId` como query param (`parseCrossCheckQuery`)
 *  sin verificar que ese empleado pertenezca a la MISMA organización que el admin
 *  autenticado (`requirePropertyMembership` ya verificó al CALLER, nunca al TARGET).
 *  Reutiliza `core.is_staff_org_member_for_org_admin` (ver `packages/db/migrations/
 *  0017_caller_binding_fase3.sql`) vía `deps.coreStaffRepo(c.get("db"))` -- MISMO
 *  umbral de autoridad que ya exige `ATTENDANCE_ADMIN_ROLES` (owner/gm ->
 *  platform_role owner/admin, ver `PLATFORM_ROLE_BY_VERTICAL_ROLE` en
 *  `@atiende/domain-hoteles`), así que el `assertVerticalRole` de cada ruta ya
 *  garantiza que este chequeo no se rechace por rango insuficiente del CALLER --
 *  solo puede rechazar por que el TARGET sea de otra organización. 404 genérico
 *  (nunca 403 "existe pero no es tuyo"): mismo criterio de no confirmar/negar
 *  existencia que el resto del monorepo (ver `StaffInviteInvalidError`). */
async function assertStaffBelongsToOrg(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string, staffUserId: string): Promise<void> {
  const belongs = await deps.coreStaffRepo(c.get("db")).isStaffOrgMember(organizationId, staffUserId);
  if (!belongs) throw Errors.notFound("Ese empleado no pertenece a esta organización.");
}

export function hotelesAsistenciaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/asistencia/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/asistencia", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- Fichaje (checador de autoservicio) ----

  app.post("/hoteles/:propertyId/asistencia/checar", async (c) => {
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId")!;
    const raw = (await c.req.json().catch(() => ({}))) as { eventType?: unknown; note?: unknown };

    if (!EVENT_TYPES.includes(raw.eventType as AttendanceEventType)) {
      throw Errors.validation('eventType: se esperaba "entrada" o "salida".');
    }
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null;

    const repo = deps.hotelesRepo(c.get("db"));
    // Nota: cualquier `staffUserId` en `raw` se ignora deliberadamente -- ver
    // comentario de cabecera del archivo.
    const event = await repo.recordAttendanceEvent({
      organizationId,
      propertyId,
      staffUserId: userId,
      eventType: raw.eventType as AttendanceEventType,
      source: "app",
      note,
    });
    return c.json(serializeEvent(event), 201);
  });

  // Ninguna ruta HTTP de edición/borrado existe para un registro de asistencia --
  // append-only real (ver migrations/010: ni UPDATE ni DELETE se permiten NUNCA sobre
  // hoteles.attendance_log, incluso con el cliente admin/service_role).

  // ---- Historial: propio empleado, o administración consultando a cualquiera ----

  app.get("/hoteles/:propertyId/asistencia", async (c) => {
    const propertyId = c.req.param("propertyId");
    const userId = c.get("userId")!;
    const verticalRole = c.get("verticalRole")!;
    const staffUserId = c.req.query("staffUserId") ?? userId;

    if (staffUserId !== userId && !(ATTENDANCE_ADMIN_ROLES as readonly string[]).includes(verticalRole)) {
      throw Errors.forbidden("No puedes consultar el historial de asistencia de otro empleado.");
    }

    const fromDate = c.req.query("desde");
    const toDate = c.req.query("hasta");
    let range: { fromDate: string; toDate: string } | undefined;
    if (fromDate || toDate) {
      if (!fromDate || !toDate || !DATE_RE.test(fromDate) || !DATE_RE.test(toDate) || fromDate > toDate) {
        throw Errors.validation("desde/hasta: formato esperado YYYY-MM-DD, desde <= hasta.");
      }
      range = { fromDate, toDate };
    }

    const repo = deps.hotelesRepo(c.get("db"));
    const events = await repo.listAttendanceEvents(propertyId, staffUserId, range);
    return c.json(events.map(serializeEvent));
  });

  // ---- Horario programado (administración) ----

  app.post("/hoteles/:propertyId/asistencia/horarios", async (c) => {
    assertVerticalRole(c, ATTENDANCE_ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = (await c.req.json().catch(() => ({}))) as {
      staffUserId?: unknown;
      workDate?: unknown;
      scheduledStart?: unknown;
      scheduledEnd?: unknown;
      authorizedOvertimeMinutes?: unknown;
    };

    const staffUserId = typeof raw.staffUserId === "string" ? raw.staffUserId.trim() : "";
    if (!staffUserId) throw Errors.validation("staffUserId: requerido.");
    const workDate = typeof raw.workDate === "string" ? raw.workDate : "";
    if (!DATE_RE.test(workDate)) throw Errors.validation("workDate: formato esperado YYYY-MM-DD.");
    const scheduledStart = typeof raw.scheduledStart === "string" ? raw.scheduledStart : "";
    const scheduledEnd = typeof raw.scheduledEnd === "string" ? raw.scheduledEnd : "";
    if (Number.isNaN(Date.parse(scheduledStart)) || Number.isNaN(Date.parse(scheduledEnd))) {
      throw Errors.validation("scheduledStart/scheduledEnd: se esperaba ISO-8601 válido.");
    }
    if (Date.parse(scheduledEnd) <= Date.parse(scheduledStart)) {
      throw Errors.validation("rango_invalido: scheduledEnd debe ser posterior a scheduledStart.");
    }
    const authorizedOvertimeMinutes =
      typeof raw.authorizedOvertimeMinutes === "number" && Number.isFinite(raw.authorizedOvertimeMinutes) && raw.authorizedOvertimeMinutes >= 0
        ? raw.authorizedOvertimeMinutes
        : 0;

    const repo = deps.hotelesRepo(c.get("db"));
    const schedule = await repo.upsertStaffSchedule({
      organizationId,
      propertyId,
      staffUserId,
      workDate,
      scheduledStart,
      scheduledEnd,
      authorizedOvertimeMinutes,
    });
    return c.json(
      {
        id: schedule.id,
        staffUserId: schedule.staffUserId,
        workDate: schedule.workDate,
        scheduledStart: schedule.scheduledStart,
        scheduledEnd: schedule.scheduledEnd,
        authorizedOvertimeMinutes: schedule.authorizedOvertimeMinutes,
      },
      201,
    );
  });

  // ---- Cruce (REQ-BO-024): horas extra NO autorizadas, día por día ----

  app.get("/hoteles/:propertyId/asistencia/cruce", async (c) => {
    assertVerticalRole(c, ATTENDANCE_ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const { staffUserId, fromDate, toDate } = parseCrossCheckQuery(c);
    await assertStaffBelongsToOrg(deps, c, organizationId, staffUserId);
    const repo = deps.hotelesRepo(c.get("db"));
    const rows = await computeCrossCheckRows(repo, propertyId, staffUserId, fromDate, toDate);
    return c.json(rows.map((r) => serializeCrossCheck(r.workDate, r.result)));
  });

  // ---- Exportación STPS (LFT art. 132 fr. XXXIV) ----

  app.get("/hoteles/:propertyId/asistencia/exportar-stps", async (c) => {
    assertVerticalRole(c, ATTENDANCE_ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const { staffUserId, fromDate, toDate } = parseCrossCheckQuery(c);
    // Hallazgo de seguridad (revisión real de PR #149): esta ruta exportaba nombre/
    // correo de CUALQUIER `staffUserId` (query param, sin validar) vía `findStaffById`
    // -- un admin de la organización A podía exportar el CSV de asistencia de un
    // empleado de la organización B (name/email incluidos), aunque `computeCrossCheckRows`
    // ya limitaba las HORAS a esta property (un `staffUserId` ajeno no tiene eventos/
    // horario aquí, así que esa parte ya salía vacía -- el leak real era la identidad).
    // `assertStaffBelongsToOrg` (mismo criterio que `ATTENDANCE_ADMIN_ROLES` =
    // owner/gm = platform_role owner/admin, ver `PLATFORM_ROLE_BY_VERTICAL_ROLE` en
    // `@atiende/domain-hoteles`) cierra el hueco: 404 genérico, sin distinguir "no
    // existe" de "es de otra organización", antes de tocar `core.staff_user`.
    await assertStaffBelongsToOrg(deps, c, organizationId, staffUserId);
    const repo = deps.hotelesRepo(c.get("db"));

    let rfcEmisor = "SIN_RFC";
    try {
      const cfg = await repo.loadHospedajeFiscalConfig(propertyId);
      rfcEmisor = cfg.rfcEmisor ?? "SIN_RFC";
    } catch {
      // Sin configuración fiscal de hospedaje sembrada (ver CFDI Fase 5): el CSV se
      // exporta de todas formas -- REQ-BO-024 (registro de asistencia) es
      // independiente de que la property ya haya configurado CFDI (H5), nunca se
      // bloquea la obligación laboral por una obligación fiscal distinta sin
      // configurar.
      //
      // Grep de cierre (auditoría a3, revisión #2 sobre PR #176) -- este `catch {}`
      // sigue usando `c.get("db")` DESPUÉS (líneas de abajo: `findStaffById`,
      // `computeCrossCheckRows`). Es SEGURO por construcción, a diferencia de los
      // sitios reales que este PR corrige: (a) es un GET de solo LECTURA -- no hay
      // ninguna escritura de negocio previa en esta misma transacción que un 25P02
      // pudiera perder; (b) el error esperado aquí es un `Error` de JS ("Sin
      // configuración fiscal..."), no uno de Postgres -- `rfcEmisor` viene de la
      // migración 038 (ya aplicada contra la base real); (c) si algún día SÍ fuera un
      // error real de Postgres, la transacción quedaría abortada (25P02) y las
      // consultas de abajo lanzarían -- el request terminaría en un 500 reintentable,
      // nunca en un CSV con datos incompletos servido como 200.
    }

    // Identidad del empleado -- `core.staff_user`, NUNCA domain-hoteles (que no posee
    // esa tabla, mismo criterio ya documentado por `HotelOrganizationSummary`/
    // `PropertySummary`: es un espejo de solo-lectura, no una copia). `deps.coreRepo`
    // es el mismo puerto que ya usa `POST /auth/login` -- `assertStaffBelongsToOrg` de
    // arriba ya confirmó que `staffUserId` es miembro de ESTA organización antes de
    // llegar aquí, así que esta lectura ya no puede devolver la identidad de un
    // empleado ajeno.
    const staffProfile = await deps.coreRepo.findStaffById(staffUserId);
    const fullName = staffProfile?.fullName ?? staffUserId;
    const email = staffProfile?.email ?? "";

    const rows = await computeCrossCheckRows(repo, propertyId, staffUserId, fromDate, toDate);
    const csv = buildStpsAttendanceCsv(
      rows.map((r) => ({ staffUserId, fullName, email, workDate: r.workDate, result: r.result })),
      rfcEmisor,
    );
    c.header("content-type", "text/csv; charset=utf-8");
    return c.body(csv, 200);
  });

  return app;
}
