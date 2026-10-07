// H-P3-04 -- el dia de housekeeping arranca solo. Puerto + adaptadores (Postgres y en memoria) de lo que el cron `housekeeping-dia`
// necesita de la SESION DE SISTEMA (`auth.uid() is null`): las tablas de housekeeping tienen RLS por staff, asi que la sesion de
// sistema no las ve ni las escribe directo; las lee/escribe a traves de las funciones `hoteles.system_hk_*` de la migracion 045
// (solo-sistema, security definer). La regla de reparto es la MISMA funcion pura que usa el boton (`planAutoAssignment`).
//
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada llamada corre dentro de `runWithSavepointFallback`; contra una base sin la
// 045 (42883/42P01/42703) se lanza `HousekeepingUnavailableError` y el cron omite la property (`omitida: migracion_pendiente`) sin
// abortar la transaccion ni romper nada de lo que ya funciona (el boton "Generar dia" sigue igual).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { InMemoryHousekeepingRepository } from "./in-memory-repository.ts";
import type { InMemoryHousekeepingResidualRepository } from "./residual-in-memory-repository.ts";
import { DEFAULT_HOUSEKEEPING_CONFIG, type HousekeepingConfigValues } from "./residual.ts";
import { HousekeepingUnavailableError, type HousekeepingPriority, type HousekeepingTaskStatus, type HousekeepingTaskType } from "./tareas.ts";

/** Config efectiva que el cron necesita (los mismos campos que la configuracion editable). */
export type HousekeepingDiaConfig = HousekeepingConfigValues;

export interface HousekeepingDiaTarea {
  readonly id: string;
  readonly roomCode: string;
  readonly taskType: HousekeepingTaskType;
  readonly priority: HousekeepingPriority;
  readonly status: HousekeepingTaskStatus;
  readonly assignedTo: string | null;
}

export interface HousekeepingDiaCamarista {
  readonly id: string;
  readonly nombre: string;
}

export interface HousekeepingDiaSistemaRepository {
  /** Configuracion efectiva de la property (defaults si nunca guardo una). */
  config(propertyId: string): Promise<HousekeepingDiaConfig>;
  /** Reclama el (property, fecha) y genera las tareas del dia. `reclamado: false` = ya arrancado antes: no se hizo nada. */
  startDay(propertyId: string, workDate: string): Promise<{ readonly reclamado: boolean; readonly generadas: number }>;
  listDayTasks(propertyId: string, workDate: string): Promise<readonly HousekeepingDiaTarea[]>;
  listCamaristas(propertyId: string): Promise<readonly HousekeepingDiaCamarista[]>;
  /** false = la tarea ya no estaba pendiente y sin responsable (carrera con una asignacion manual). */
  assignTask(propertyId: string, taskId: string, camaristaId: string): Promise<boolean>;
  finishDay(propertyId: string, workDate: string, asignadas: number, sinAsignar: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

interface ConfigRow {
  out_auto_assign_enabled: boolean; out_max_tasks_per_camarista: number; out_shift_minutes: number; out_minutes_salida: number;
  out_minutes_estancia: number; out_minutes_profunda: number; out_minutes_repaso: number; out_start_hour: number;
}
interface TaskRow {
  out_task_id: string; out_room_code: string; out_task_type: HousekeepingTaskType; out_priority: HousekeepingPriority;
  out_status: HousekeepingTaskStatus; out_assigned_to: string | null;
}

export class PostgresHousekeepingDiaSistemaRepository implements HousekeepingDiaSistemaRepository {
  constructor(private readonly db: TenantDbSession) {}

  private run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: isMigrationPendingError,
      fallback: () => {
        throw new HousekeepingUnavailableError(operation);
      },
    });
  }

  config(propertyId: string): Promise<HousekeepingDiaConfig> {
    return this.run("systemHkConfig", async () => {
      const { rows } = await this.db.query<ConfigRow>(`select * from hoteles.system_hk_config($1);`, [propertyId]);
      const r = rows[0];
      if (!r) return DEFAULT_HOUSEKEEPING_CONFIG;
      return {
        autoAssignEnabled: r.out_auto_assign_enabled,
        maxTasksPerCamarista: Number(r.out_max_tasks_per_camarista),
        shiftMinutes: Number(r.out_shift_minutes),
        minutesByType: { salida: Number(r.out_minutes_salida), estancia: Number(r.out_minutes_estancia), profunda: Number(r.out_minutes_profunda), repaso: Number(r.out_minutes_repaso) },
        photosRequiredOnInspection: DEFAULT_HOUSEKEEPING_CONFIG.photosRequiredOnInspection,
        maxPhotosPerTask: DEFAULT_HOUSEKEEPING_CONFIG.maxPhotosPerTask,
        startHour: Number(r.out_start_hour),
      };
    });
  }

  startDay(propertyId: string, workDate: string) {
    return this.run("systemHkStartDay", async () => {
      const { rows } = await this.db.query<{ out_claimed: boolean; out_generated: number }>(`select * from hoteles.system_hk_start_day($1, $2::date);`, [propertyId, workDate]);
      return { reclamado: rows[0]?.out_claimed === true, generadas: Number(rows[0]?.out_generated ?? 0) };
    });
  }

  listDayTasks(propertyId: string, workDate: string): Promise<readonly HousekeepingDiaTarea[]> {
    return this.run("systemHkListDayTasks", async () => {
      const { rows } = await this.db.query<TaskRow>(`select * from hoteles.system_hk_list_day_tasks($1, $2::date);`, [propertyId, workDate]);
      return rows.map((r) => ({ id: r.out_task_id, roomCode: r.out_room_code, taskType: r.out_task_type, priority: r.out_priority, status: r.out_status, assignedTo: r.out_assigned_to }));
    });
  }

  listCamaristas(propertyId: string): Promise<readonly HousekeepingDiaCamarista[]> {
    return this.run("systemHkListCamaristas", async () => {
      const { rows } = await this.db.query<{ out_user_id: string; out_full_name: string }>(`select * from hoteles.system_hk_list_camaristas($1);`, [propertyId]);
      return rows.map((r) => ({ id: r.out_user_id, nombre: r.out_full_name }));
    });
  }

  assignTask(propertyId: string, taskId: string, camaristaId: string): Promise<boolean> {
    return this.run("systemHkAssignTask", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select hoteles.system_hk_assign_task($1, $2, $3) as ok;`, [propertyId, taskId, camaristaId]);
      return rows[0]?.ok === true;
    });
  }

  finishDay(propertyId: string, workDate: string, asignadas: number, sinAsignar: number): Promise<void> {
    return this.run("systemHkFinishDay", async () => {
      await this.db.query(`select hoteles.system_hk_finish_day($1, $2::date, $3::int, $4::int);`, [propertyId, workDate, asignadas, sinAsignar]);
    });
  }
}

// ---------------------------------------------------------------------------
// En memoria (pruebas HTTP): se apoya en los espejos existentes de tareas y de configuracion/opt-out para que la regla de
// generacion sea LA MISMA que la del boton, y agrega el ledger por (property, fecha).
// ---------------------------------------------------------------------------

export class InMemoryHousekeepingDiaSistemaRepository implements HousekeepingDiaSistemaRepository {
  private readonly ledger = new Map<string, { generadas: number; asignadas: number; sinAsignar: number }>();
  private readonly camaristas = new Map<string, HousekeepingDiaCamarista[]>();
  /** `false` simula una base SIN la migracion 045 (toda operacion lanza `HousekeepingUnavailableError`). */
  migrated = true;

  constructor(
    private readonly hk: InMemoryHousekeepingRepository,
    private readonly residual: InMemoryHousekeepingResidualRepository,
  ) {}

  seedCamarista(propertyId: string, camarista: HousekeepingDiaCamarista): void {
    this.hk.seedStaff(propertyId, camarista.id);
    this.camaristas.set(propertyId, [...(this.camaristas.get(propertyId) ?? []), camarista]);
  }
  ledgerOf(propertyId: string, workDate: string) {
    return this.ledger.get(`${propertyId}:${workDate}`);
  }
  private require(operation: string): void {
    if (!this.migrated) throw new HousekeepingUnavailableError(operation);
  }

  async config(propertyId: string): Promise<HousekeepingDiaConfig> {
    this.require("systemHkConfig");
    const { config } = await this.residual.getConfig(propertyId);
    const { propertyId: _p, personalizada: _pe, updatedAt: _u, startHourDisponible: _s, ...values } = config;
    return values;
  }

  async startDay(propertyId: string, workDate: string) {
    this.require("systemHkStartDay");
    const key = `${propertyId}:${workDate}`;
    if (this.ledger.has(key)) return { reclamado: false, generadas: 0 };
    this.ledger.set(key, { generadas: 0, asignadas: 0, sinAsignar: 0 });
    const opt = await this.residual.listOptOuts(propertyId, workDate);
    const skip = opt.optOuts.filter((o) => o.status === "activo").map((o) => o.roomId);
    const generadas = await this.hk.generateDay(propertyId, workDate, "sistema", skip);
    this.ledger.get(key)!.generadas = generadas;
    return { reclamado: true, generadas };
  }

  async listDayTasks(propertyId: string, workDate: string): Promise<readonly HousekeepingDiaTarea[]> {
    this.require("systemHkListDayTasks");
    const tasks = await this.hk.listTasks(propertyId, { workDate });
    return tasks.map((t) => ({ id: t.id, roomCode: t.roomCode, taskType: t.taskType, priority: t.priority, status: t.status, assignedTo: t.assignedTo }));
  }

  async listCamaristas(propertyId: string): Promise<readonly HousekeepingDiaCamarista[]> {
    this.require("systemHkListCamaristas");
    return this.camaristas.get(propertyId) ?? [];
  }

  async assignTask(propertyId: string, taskId: string, camaristaId: string): Promise<boolean> {
    this.require("systemHkAssignTask");
    const task = await this.hk.findTask(propertyId, taskId);
    if (!task || task.status !== "pendiente" || task.assignedTo !== null) return false;
    return (await this.hk.assignTask(propertyId, taskId, camaristaId)) !== null;
  }

  async finishDay(propertyId: string, workDate: string, asignadas: number, sinAsignar: number): Promise<void> {
    this.require("systemHkFinishDay");
    const row = this.ledger.get(`${propertyId}:${workDate}`);
    if (row) {
      row.asignadas = asignadas;
      row.sinAsignar = sinAsignar;
    }
  }
}
