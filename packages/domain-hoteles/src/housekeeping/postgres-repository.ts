// Adaptador Postgres del housekeeping completo (H-04) sobre `TenantDbSession` (auth.uid()
// real por request). REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es
// UNA transaccion por request; un error de Postgres (42P01 si la migracion 033 no esta
// aplicada) la dejaria ABORTADA (25P02). Toda operacion corre dentro de
// `runWithSavepointFallback`: las lecturas degradan a vacio honesto
// (`tareasDisponibles: false`), las escrituras a `HousekeepingUnavailableError` (503).
// El SQL de generar-dia/tablero/reporte es el MISMO que ejercita
// scripts/verify-hoteles-housekeeping contra Postgres real (escenarios 20-22).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { HousekeepingRepository } from "./repository.ts";
import {
  HousekeepingAccessDeniedError,
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  canSetOutOfService,
  emptyRoomStatusCounts,
  roomStatusForOutOfService,
  summarizeTasks,
} from "./tareas.ts";
import type {
  HotelRoomStatus,
  HousekeepingBoardResult,
  HousekeepingBoardRow,
  HousekeepingDailyReport,
  HousekeepingPriority,
  HousekeepingTaskFilter,
  HousekeepingTaskRecord,
  HousekeepingTaskStatus,
  HousekeepingTaskType,
  InspectionResult,
  NewHousekeepingTaskInput,
  NewOutOfServiceInput,
  OutOfServiceKind,
  OutOfServiceRecord,
} from "./tareas.ts";

const TASK_SELECT = `t.id, t.property_id, t.room_id, r.code as room_code, t.task_type, t.status, t.priority, t.work_date::text as work_date,
       t.assigned_to, t.notes, t.started_at::text as started_at, t.finished_at::text as finished_at, t.inspection_result,
       t.inspected_by, t.inspected_at::text as inspected_at, t.inspection_note, t.rejections, t.created_by,
       t.created_at::text as created_at, t.updated_at::text as updated_at`;
const TASK_FROM = `from hoteles.housekeeping_task t join hoteles.room r on r.id = t.room_id`;

interface TaskRow {
  id: string; property_id: string; room_id: string; room_code: string; task_type: HousekeepingTaskType; status: HousekeepingTaskStatus;
  priority: HousekeepingPriority; work_date: string; assigned_to: string | null; notes: string | null; started_at: string | null;
  finished_at: string | null; inspection_result: InspectionResult | null; inspected_by: string | null; inspected_at: string | null;
  inspection_note: string | null; rejections: number; created_by: string | null; created_at: string; updated_at: string;
}

function mapTask(r: TaskRow): HousekeepingTaskRecord {
  return {
    id: r.id, propertyId: r.property_id, roomId: r.room_id, roomCode: r.room_code, taskType: r.task_type, status: r.status,
    priority: r.priority, workDate: r.work_date, assignedTo: r.assigned_to, notes: r.notes, startedAt: r.started_at,
    finishedAt: r.finished_at, inspectionResult: r.inspection_result, inspectedBy: r.inspected_by, inspectedAt: r.inspected_at,
    inspectionNote: r.inspection_note, rejections: Number(r.rejections), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const OOS_SELECT = `o.id, o.property_id, o.room_id, r.code as room_code, o.kind, o.reason, o.from_date::text as from_date,
       o.expected_return_date::text as expected_return_date, o.status, o.maintenance_ticket_id, o.created_by, o.closed_by,
       o.closed_at::text as closed_at, o.created_at::text as created_at`;
const OOS_FROM = `from hoteles.room_out_of_service o join hoteles.room r on r.id = o.room_id`;

interface OosRow {
  id: string; property_id: string; room_id: string; room_code: string; kind: OutOfServiceKind; reason: string; from_date: string;
  expected_return_date: string | null; status: "activo" | "cerrado"; maintenance_ticket_id: string | null; created_by: string | null;
  closed_by: string | null; closed_at: string | null; created_at: string;
}

function mapOos(r: OosRow): OutOfServiceRecord {
  return {
    id: r.id, propertyId: r.property_id, roomId: r.room_id, roomCode: r.room_code, kind: r.kind, reason: r.reason, fromDate: r.from_date,
    expectedReturnDate: r.expected_return_date, status: r.status, maintenanceTicketId: r.maintenance_ticket_id, createdBy: r.created_by,
    closedBy: r.closed_by, closedAt: r.closed_at, createdAt: r.created_at,
  };
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce un error de Postgres a un error de dominio tipado (nunca un 500 crudo). */
export function mapHousekeepingPgError(err: unknown, operation: string): unknown {
  if (err instanceof HousekeepingNotFoundError || err instanceof HousekeepingConflictError || err instanceof HousekeepingInvalidInputError) return err;
  if (isMigrationPendingError(err)) return new HousekeepingUnavailableError(operation);
  switch (pgCode(err)) {
    case "23503":
      return new HousekeepingNotFoundError("Habitacion o responsable");
    case "23505":
      return new HousekeepingConflictError("Ya existe una tarea activa (o inhabilitacion activa) para esa habitacion.");
    case "23514":
      return new HousekeepingInvalidInputError("Datos invalidos para esta operacion de housekeeping (o el responsable no es staff de esta property).");
    case "42501":
      return new HousekeepingAccessDeniedError();
    default:
      return err;
  }
}

export class PostgresHousekeepingRepository implements HousekeepingRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapHousekeepingPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se repropaga. */
  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => Promise<T> | T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        console.warn(`${operation}: housekeeping completo (migracion 033) aun no aplicado -- degradando:`, err instanceof Error ? err.message : err);
        return Promise.resolve(onMissing());
      },
    });
  }

  async getBoard(propertyId: string, workDate: string): Promise<HousekeepingBoardResult> {
    return this.read<HousekeepingBoardResult>(
      "getBoard",
      async () => {
        const { rows } = await this.db.query<{
          room_id: string; code: string; room_status: HotelRoomStatus; room_type_name: string;
          task_id: string | null; task_type: HousekeepingTaskType | null; task_status: HousekeepingTaskStatus | null;
          priority: HousekeepingPriority | null; assigned_to: string | null; rejections: number | null;
          oos_id: string | null; oos_kind: OutOfServiceKind | null; oos_reason: string | null; expected_return_date: string | null;
        }>(
          `select r.id as room_id, r.code, r.status as room_status, rt.name as room_type_name,
                  t.id as task_id, t.task_type, t.status as task_status, t.priority, t.assigned_to, t.rejections,
                  o.id as oos_id, o.kind as oos_kind, o.reason as oos_reason, o.expected_return_date::text as expected_return_date
           from hoteles.room r
           join hoteles.room_type rt on rt.id = r.room_type_id
           left join lateral (
             select * from hoteles.housekeeping_task x
             where x.room_id = r.id and x.work_date = $2::date and x.status <> 'cancelada'
             order by x.created_at desc limit 1
           ) t on true
           left join hoteles.room_out_of_service o on o.room_id = r.id and o.status = 'activo'
           where r.property_id = $1
           order by r.code asc;`,
          [propertyId, workDate],
        );
        const mapped: HousekeepingBoardRow[] = rows.map((r) => ({
          roomId: r.room_id,
          code: r.code,
          roomType: r.room_type_name,
          roomStatus: r.room_status,
          task: r.task_id
            ? { id: r.task_id, taskType: r.task_type as HousekeepingTaskType, status: r.task_status as HousekeepingTaskStatus, priority: r.priority as HousekeepingPriority, assignedTo: r.assigned_to, rejections: Number(r.rejections ?? 0) }
            : null,
          outOfService: r.oos_id ? { id: r.oos_id, kind: r.oos_kind as OutOfServiceKind, reason: r.oos_reason ?? "", expectedReturnDate: r.expected_return_date } : null,
        }));
        return { tareasDisponibles: true, rows: mapped };
      },
      async () => {
        const { rows } = await this.db.query<{ room_id: string; code: string; room_status: HotelRoomStatus; room_type_name: string }>(
          `select r.id as room_id, r.code, r.status as room_status, rt.name as room_type_name
           from hoteles.room r join hoteles.room_type rt on rt.id = r.room_type_id
           where r.property_id = $1 order by r.code asc;`,
          [propertyId],
        );
        return {
          tareasDisponibles: false,
          rows: rows.map((r) => ({ roomId: r.room_id, code: r.code, roomType: r.room_type_name, roomStatus: r.room_status, task: null, outOfService: null })),
        };
      },
    );
  }

  async generateDay(propertyId: string, workDate: string, createdBy: string): Promise<number> {
    return this.write("generateDay", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, created_by)
         select r.property_id, r.id, case when r.status = 'ocupada' then 'estancia' else 'salida' end, 'normal', $2::date, $3::uuid
         from hoteles.room r
         where r.property_id = $1 and r.status in ('sucia', 'ocupada')
           and not exists (select 1 from hoteles.room_out_of_service o where o.room_id = r.id and o.status = 'activo')
           and not exists (select 1 from hoteles.housekeeping_task t where t.room_id = r.id and t.work_date = $2::date and t.status <> 'cancelada')
         on conflict do nothing
         returning id;`,
        [propertyId, workDate, createdBy],
      );
      return rows.length;
    });
  }

  private async selectTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null> {
    const { rows } = await this.db.query<TaskRow>(`select ${TASK_SELECT} ${TASK_FROM} where t.id = $1 and t.property_id = $2;`, [taskId, propertyId]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async createTask(input: NewHousekeepingTaskInput): Promise<HousekeepingTaskRecord> {
    return this.write("createTask", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, assigned_to, notes, created_by)
         values ($1, $2, $3, $4, $5::date, $6, $7, $8) returning id;`,
        [input.propertyId, input.roomId, input.taskType, input.priority, input.workDate, input.assignedTo, input.notes, input.createdBy],
      );
      const created = await this.selectTask(input.propertyId, rows[0]!.id);
      if (!created) throw new HousekeepingNotFoundError("Tarea");
      return created;
    });
  }

  async findTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null> {
    return this.read("findTask", () => this.selectTask(propertyId, taskId), () => null);
  }

  async listTasks(propertyId: string, filter: HousekeepingTaskFilter): Promise<readonly HousekeepingTaskRecord[]> {
    return this.read<readonly HousekeepingTaskRecord[]>(
      "listTasks",
      async () => {
        const params: unknown[] = [propertyId, filter.workDate];
        let where = `t.property_id = $1 and t.work_date = $2::date`;
        if (filter.status) { params.push(filter.status); where += ` and t.status = $${params.length}`; }
        if (filter.assignedTo) { params.push(filter.assignedTo); where += ` and t.assigned_to = $${params.length}`; }
        const { rows } = await this.db.query<TaskRow>(`select ${TASK_SELECT} ${TASK_FROM} where ${where} order by r.code asc limit 500;`, params);
        return rows.map(mapTask);
      },
      () => [],
    );
  }

  /** UPDATE con guarda de estado: `null` si ninguna fila cumplio la guarda. */
  private async guardedUpdate(propertyId: string, taskId: string, setSql: string, params: unknown[], fromStatuses: readonly HousekeepingTaskStatus[]): Promise<HousekeepingTaskRecord | null> {
    const base = params.length;
    const { rows } = await this.db.query<{ id: string }>(
      `update hoteles.housekeeping_task set ${setSql}, updated_at = now()
       where id = $${base + 1} and property_id = $${base + 2} and status = any($${base + 3}::text[]) returning id;`,
      [...params, taskId, propertyId, [...fromStatuses]],
    );
    if (!rows[0]) return null;
    return this.selectTask(propertyId, taskId);
  }

  startTask(propertyId: string, taskId: string, actorId: string) {
    return this.write("startTask", () =>
      this.guardedUpdate(propertyId, taskId, `status = 'en_progreso', started_at = now(), assigned_to = coalesce(assigned_to, $1::uuid)`, [actorId], ["pendiente"]),
    );
  }

  finishTask(propertyId: string, taskId: string) {
    return this.write("finishTask", () => this.guardedUpdate(propertyId, taskId, `status = 'terminada', finished_at = now()`, [], ["en_progreso"]));
  }

  inspectTask(propertyId: string, taskId: string, input: { readonly inspectorId: string; readonly approved: boolean; readonly note: string | null }) {
    return this.write("inspectTask", async () => {
      const updated = input.approved
        ? await this.guardedUpdate(
            propertyId,
            taskId,
            `status = 'inspeccionada', inspection_result = 'aprobada', inspected_by = $1::uuid, inspected_at = now(), inspection_note = $2`,
            [input.inspectorId, input.note],
            ["terminada"],
          )
        : await this.guardedUpdate(
            propertyId,
            taskId,
            `status = 'pendiente', inspection_result = 'rechazada', inspected_by = $1::uuid, inspected_at = now(), inspection_note = $2,
             rejections = rejections + 1, started_at = null, finished_at = null`,
            [input.inspectorId, input.note],
            ["terminada"],
          );
      if (updated && input.approved) {
        // Solo una habitacion `sucia` se libera (la guarda vive en el WHERE).
        await this.db.query(`update hoteles.room set status = 'disponible' where id = $1 and property_id = $2 and status = 'sucia';`, [updated.roomId, propertyId]);
      }
      return updated;
    });
  }

  assignTask(propertyId: string, taskId: string, assignedTo: string) {
    return this.write("assignTask", () => this.guardedUpdate(propertyId, taskId, `assigned_to = $1::uuid`, [assignedTo], ["pendiente", "en_progreso"]));
  }

  cancelTask(propertyId: string, taskId: string) {
    return this.write("cancelTask", () => this.guardedUpdate(propertyId, taskId, `status = 'cancelada'`, [], ["pendiente", "en_progreso", "terminada"]));
  }

  async findRoom(propertyId: string, roomId: string) {
    const { rows } = await this.db.query<{ id: string; code: string; status: HotelRoomStatus }>(
      `select id, code, status from hoteles.room where id = $1 and property_id = $2;`,
      [roomId, propertyId],
    );
    return rows[0] ?? null;
  }

  async markRoomDirty(propertyId: string, roomId: string): Promise<HotelRoomStatus | null> {
    return this.write("markRoomDirty", async () => {
      const { rows } = await this.db.query<{ status: HotelRoomStatus }>(
        `update hoteles.room set status = 'sucia' where id = $1 and property_id = $2 and status in ('disponible', 'ocupada') returning status;`,
        [roomId, propertyId],
      );
      return rows[0]?.status ?? null;
    });
  }

  async markRoomOccupied(propertyId: string, roomId: string): Promise<HotelRoomStatus | null> {
    return this.write("markRoomOccupied", async () => {
      const { rows } = await this.db.query<{ status: HotelRoomStatus }>(
        `update hoteles.room set status = 'ocupada' where id = $1 and property_id = $2 and status = 'disponible' returning status;`,
        [roomId, propertyId],
      );
      return rows[0]?.status ?? null;
    });
  }

  async listOutOfService(propertyId: string, onlyActive: boolean): Promise<readonly OutOfServiceRecord[]> {
    return this.read<readonly OutOfServiceRecord[]>(
      "listOutOfService",
      async () => {
        const { rows } = await this.db.query<OosRow>(
          `select ${OOS_SELECT} ${OOS_FROM} where o.property_id = $1 ${onlyActive ? "and o.status = 'activo'" : ""} order by o.created_at desc limit 200;`,
          [propertyId],
        );
        return rows.map(mapOos);
      },
      () => [],
    );
  }

  async setOutOfService(input: NewOutOfServiceInput): Promise<OutOfServiceRecord> {
    return this.write("setOutOfService", async () => {
      const { rows: roomRows } = await this.db.query<{ status: HotelRoomStatus }>(
        `select status from hoteles.room where id = $1 and property_id = $2 for update;`,
        [input.roomId, input.propertyId],
      );
      const room = roomRows[0];
      if (!room) throw new HousekeepingNotFoundError("Habitacion");
      if (!canSetOutOfService(room.status)) throw new HousekeepingConflictError("La habitacion esta ocupada: espera al check-out para inhabilitarla.");
      const { rows } = await this.db.query<{ id: string }>(
        `insert into hoteles.room_out_of_service (property_id, room_id, kind, reason, from_date, expected_return_date, maintenance_ticket_id, created_by)
         values ($1, $2, $3, $4, $5::date, $6::date, $7, $8) returning id;`,
        [input.propertyId, input.roomId, input.kind, input.reason, input.fromDate, input.expectedReturnDate, input.maintenanceTicketId, input.createdBy],
      );
      await this.db.query(`update hoteles.room set status = $1 where id = $2 and property_id = $3;`, [roomStatusForOutOfService(input.kind), input.roomId, input.propertyId]);
      const { rows: out } = await this.db.query<OosRow>(`select ${OOS_SELECT} ${OOS_FROM} where o.id = $1;`, [rows[0]!.id]);
      return mapOos(out[0]!);
    });
  }

  async returnToService(propertyId: string, outOfServiceId: string, actorId: string): Promise<OutOfServiceRecord | null> {
    return this.write("returnToService", async () => {
      const { rows } = await this.db.query<{ id: string; room_id: string }>(
        `update hoteles.room_out_of_service set status = 'cerrado', closed_by = $1::uuid, closed_at = now()
         where id = $2 and property_id = $3 and status = 'activo' returning id, room_id;`,
        [actorId, outOfServiceId, propertyId],
      );
      if (!rows[0]) return null;
      await this.db.query(
        `update hoteles.room set status = 'sucia' where id = $1 and property_id = $2 and status in ('fuera_de_servicio', 'mantenimiento');`,
        [rows[0].room_id, propertyId],
      );
      const { rows: out } = await this.db.query<OosRow>(`select ${OOS_SELECT} ${OOS_FROM} where o.id = $1;`, [outOfServiceId]);
      return out[0] ? mapOos(out[0]) : null;
    });
  }

  async dailyReport(propertyId: string, workDate: string): Promise<HousekeepingDailyReport> {
    const roomCounts = async () => {
      const { rows } = await this.db.query<{ status: HotelRoomStatus; n: string }>(
        `select status, count(*)::text as n from hoteles.room where property_id = $1 group by status;`,
        [propertyId],
      );
      const counts = emptyRoomStatusCounts();
      for (const r of rows) counts[r.status] = Number(r.n);
      return counts;
    };
    return this.read<HousekeepingDailyReport>(
      "dailyReport",
      async () => {
        const { rows } = await this.db.query<{
          assigned_to: string | null; total: string; pendientes: string; en_progreso: string; por_inspeccionar: string;
          inspeccionadas: string; rechazos: string; minutos_promedio: string | null;
        }>(
          `select t.assigned_to, count(*)::text as total,
                  count(*) filter (where t.status = 'pendiente')::text as pendientes,
                  count(*) filter (where t.status = 'en_progreso')::text as en_progreso,
                  count(*) filter (where t.status = 'terminada')::text as por_inspeccionar,
                  count(*) filter (where t.status = 'inspeccionada')::text as inspeccionadas,
                  coalesce(sum(t.rejections), 0)::text as rechazos,
                  round(avg(extract(epoch from (t.finished_at - t.started_at)) / 60) filter (where t.started_at is not null and t.finished_at is not null))::text as minutos_promedio
           from hoteles.housekeeping_task t
           where t.property_id = $1 and t.work_date = $2::date and t.status <> 'cancelada'
           group by t.assigned_to order by t.assigned_to nulls first;`,
          [propertyId, workDate],
        );
        const porResponsable = rows.map((r) => ({
          assignedTo: r.assigned_to,
          total: Number(r.total),
          pendientes: Number(r.pendientes),
          enProgreso: Number(r.en_progreso),
          porInspeccionar: Number(r.por_inspeccionar),
          inspeccionadas: Number(r.inspeccionadas),
          rechazos: Number(r.rechazos),
          minutosPromedio: r.minutos_promedio === null ? null : Number(r.minutos_promedio),
        }));
        const totales = {
          total: porResponsable.reduce((a, r) => a + r.total, 0),
          pendientes: porResponsable.reduce((a, r) => a + r.pendientes, 0),
          enProgreso: porResponsable.reduce((a, r) => a + r.enProgreso, 0),
          porInspeccionar: porResponsable.reduce((a, r) => a + r.porInspeccionar, 0),
          inspeccionadas: porResponsable.reduce((a, r) => a + r.inspeccionadas, 0),
          rechazos: porResponsable.reduce((a, r) => a + r.rechazos, 0),
        };
        const { rows: oosRows } = await this.db.query<{ n: string }>(
          `select count(*)::text as n from hoteles.room_out_of_service where property_id = $1 and status = 'activo';`,
          [propertyId],
        );
        return { tareasDisponibles: true, workDate, totales, porResponsable, habitacionesPorEstado: await roomCounts(), fueraDeServicioActivas: Number(oosRows[0]?.n ?? 0) };
      },
      async () => ({
        tareasDisponibles: false,
        workDate,
        ...summarizeTasks([]),
        habitacionesPorEstado: await roomCounts(),
        fueraDeServicioActivas: 0,
      }),
    );
  }
}
