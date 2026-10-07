// Adaptador Postgres del housekeeping residual (H-26) sobre `TenantDbSession` (auth.uid() real por request).
// REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de
// Postgres (42P01 si la migracion 039 no esta aplicada) la dejaria ABORTADA (25P02). Toda operacion corre dentro de
// `runWithSavepointFallback`: las lecturas degradan a vacio honesto, las escrituras a HousekeepingUnavailableError.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { HousekeepingResidualRepository } from "./residual-repository.ts";
import {
  DEFAULT_HOUSEKEEPING_CONFIG,
  mergeHousekeepingConfig,
  type CleaningOptOutRecord,
  type HousekeepingConfig,
  type HousekeepingConfigPatch,
  type HousekeepingConfigValues,
  type LinenCountInput,
  type LinenCountRecord,
  type LinenItem,
  type NewCleaningOptOutInput,
  type NewTaskPhotoInput,
  type OptOutSource,
  type PhotoContentType,
  type TaskPhotoRecord,
} from "./residual.ts";
import {
  HousekeepingAccessDeniedError,
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  type HousekeepingTaskType,
} from "./tareas.ts";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Traduce un error de Postgres a un error de dominio tipado (nunca un 500 crudo). */
export function mapResidualPgError(err: unknown, operation: string): unknown {
  if (err instanceof HousekeepingNotFoundError || err instanceof HousekeepingConflictError || err instanceof HousekeepingInvalidInputError) return err;
  if (isMigrationPendingError(err)) return new HousekeepingUnavailableError(operation);
  switch (pgCode(err)) {
    case "23503":
      return new HousekeepingNotFoundError("Tarea o habitacion");
    case "23505":
      return new HousekeepingConflictError("Ya existe un registro activo para esa habitacion y fecha.");
    case "23514":
      return new HousekeepingConflictError("La tarea ya tiene el maximo de fotos, esta cancelada o los datos no son validos.");
    case "42501":
      return new HousekeepingAccessDeniedError();
    default:
      return err;
  }
}

interface ConfigRow {
  property_id: string; auto_assign_enabled: boolean; max_tasks_per_camarista: number; shift_minutes: number;
  minutes_salida: number; minutes_estancia: number; minutes_profunda: number; minutes_repaso: number;
  photos_required_on_inspection: boolean; max_photos_per_task: number; updated_at: string;
}

function mapConfig(r: ConfigRow): HousekeepingConfig {
  return {
    propertyId: r.property_id,
    autoAssignEnabled: r.auto_assign_enabled,
    maxTasksPerCamarista: Number(r.max_tasks_per_camarista),
    shiftMinutes: Number(r.shift_minutes),
    minutesByType: { salida: Number(r.minutes_salida), estancia: Number(r.minutes_estancia), profunda: Number(r.minutes_profunda), repaso: Number(r.minutes_repaso) },
    photosRequiredOnInspection: r.photos_required_on_inspection,
    maxPhotosPerTask: Number(r.max_photos_per_task),
    startHour: DEFAULT_HOUSEKEEPING_CONFIG.startHour,
    startHourDisponible: false,
    personalizada: true,
    updatedAt: r.updated_at,
  };
}

const CONFIG_COLUMNS = `property_id, auto_assign_enabled, max_tasks_per_camarista, shift_minutes, minutes_salida, minutes_estancia,
       minutes_profunda, minutes_repaso, photos_required_on_inspection, max_photos_per_task, updated_at::text as updated_at`;

function defaultConfig(propertyId: string): HousekeepingConfig {
  return { propertyId, ...DEFAULT_HOUSEKEEPING_CONFIG, startHourDisponible: false, personalizada: false, updatedAt: null };
}

interface PhotoRow { id: string; task_id: string; content_type: PhotoContentType; byte_size: number; caption: string | null; taken_by: string | null; created_at: string }
const PHOTO_COLUMNS = `id, task_id, content_type, byte_size, caption, taken_by, created_at::text as created_at`;
function mapPhoto(r: PhotoRow): TaskPhotoRecord {
  return { id: r.id, taskId: r.task_id, contentType: r.content_type, byteSize: Number(r.byte_size), caption: r.caption, takenBy: r.taken_by, createdAt: r.created_at };
}

interface LinenRow { item: LinenItem; count_date: string; qty_clean: number; qty_dirty: number; qty_laundry: number; qty_damaged: number; counted_by: string | null; updated_at: string }
const LINEN_COLUMNS = `item, count_date::text as count_date, qty_clean, qty_dirty, qty_laundry, qty_damaged, counted_by, updated_at::text as updated_at`;
function mapLinen(r: LinenRow): LinenCountRecord {
  return {
    item: r.item, countDate: r.count_date, qtyClean: Number(r.qty_clean), qtyDirty: Number(r.qty_dirty), qtyLaundry: Number(r.qty_laundry),
    qtyDamaged: Number(r.qty_damaged), countedBy: r.counted_by, updatedAt: r.updated_at,
  };
}

interface OptOutRow {
  id: string; room_id: string; room_code: string; opt_out_date: string; source: OptOutSource; note: string | null;
  status: "activo" | "revertido"; created_by: string | null; created_at: string; reverted_at: string | null;
}
const OPT_OUT_SELECT = `o.id, o.room_id, r.code as room_code, o.opt_out_date::text as opt_out_date, o.source, o.note, o.status, o.created_by,
       o.created_at::text as created_at, o.reverted_at::text as reverted_at`;
function mapOptOut(r: OptOutRow): CleaningOptOutRecord {
  return {
    id: r.id, roomId: r.room_id, roomCode: r.room_code, optOutDate: r.opt_out_date, source: r.source, note: r.note, status: r.status,
    createdBy: r.created_by, createdAt: r.created_at, revertedAt: r.reverted_at,
  };
}

export class PostgresHousekeepingResidualRepository implements HousekeepingResidualRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapResidualPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se repropaga. */
  private read<T>(primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: () => Promise.resolve(onMissing()),
    });
  }

  /** H-P3-04: la hora de arranque vive en una columna de la migracion 045. Se lee APARTE (con su propio SAVEPOINT) para que una base
   *  con la 039 pero sin la 045 siga sirviendo la configuracion de siempre: `disponible: false` y el default 7. */
  private readStartHour(propertyId: string): Promise<{ readonly disponible: boolean; readonly startHour: number }> {
    return this.read<{ readonly disponible: boolean; readonly startHour: number }>(
      async () => {
        const { rows } = await this.db.query<{ start_hour: number }>(`select start_hour from hoteles.housekeeping_config where property_id = $1;`, [propertyId]);
        return { disponible: true, startHour: rows[0] ? Number(rows[0].start_hour) : DEFAULT_HOUSEKEEPING_CONFIG.startHour };
      },
      () => ({ disponible: false, startHour: DEFAULT_HOUSEKEEPING_CONFIG.startHour }),
    );
  }

  getConfig(propertyId: string) {
    return this.read<{ disponible: boolean; config: HousekeepingConfig }>(
      async () => {
        const { rows } = await this.db.query<ConfigRow>(`select ${CONFIG_COLUMNS} from hoteles.housekeeping_config where property_id = $1;`, [propertyId]);
        const config = rows[0] ? mapConfig(rows[0]) : defaultConfig(propertyId);
        const hora = await this.readStartHour(propertyId);
        return { disponible: true, config: { ...config, startHour: hora.startHour, startHourDisponible: hora.disponible } };
      },
      () => ({ disponible: false, config: defaultConfig(propertyId) }),
    );
  }

  saveConfig(propertyId: string, patch: HousekeepingConfigPatch, actorId: string): Promise<HousekeepingConfig> {
    return this.write("saveConfig", async () => {
      const { rows: existing } = await this.db.query<ConfigRow>(`select ${CONFIG_COLUMNS} from hoteles.housekeeping_config where property_id = $1;`, [propertyId]);
      const base: HousekeepingConfigValues = existing[0] ? mapConfig(existing[0]) : DEFAULT_HOUSEKEEPING_CONFIG;
      const next = mergeHousekeepingConfig(base, patch);
      const { rows } = await this.db.query<ConfigRow>(
        `insert into hoteles.housekeeping_config (property_id, auto_assign_enabled, max_tasks_per_camarista, shift_minutes, minutes_salida, minutes_estancia,
                minutes_profunda, minutes_repaso, photos_required_on_inspection, max_photos_per_task, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (property_id) do update set auto_assign_enabled = excluded.auto_assign_enabled, max_tasks_per_camarista = excluded.max_tasks_per_camarista,
           shift_minutes = excluded.shift_minutes, minutes_salida = excluded.minutes_salida, minutes_estancia = excluded.minutes_estancia,
           minutes_profunda = excluded.minutes_profunda, minutes_repaso = excluded.minutes_repaso,
           photos_required_on_inspection = excluded.photos_required_on_inspection, max_photos_per_task = excluded.max_photos_per_task,
           updated_by = excluded.updated_by, updated_at = now()
         returning ${CONFIG_COLUMNS};`,
        [
          propertyId, next.autoAssignEnabled, next.maxTasksPerCamarista, next.shiftMinutes, next.minutesByType.salida, next.minutesByType.estancia,
          next.minutesByType.profunda, next.minutesByType.repaso, next.photosRequiredOnInspection, next.maxPhotosPerTask, actorId,
        ],
      );
      const saved = mapConfig(rows[0]!);
      if (patch.startHour === undefined) {
        const hora = await this.readStartHour(propertyId);
        return { ...saved, startHour: hora.startHour, startHourDisponible: hora.disponible };
      }
      // Escritura aislada de la columna de la 045: sin la migracion (42703) el SAVEPOINT de `write` deshace TODO el PUT y la ruta
      // responde 503 "no disponible aun", nunca un 500 ni una configuracion a medias.
      const { rows: hora } = await this.db.query<{ start_hour: number }>(
        `update hoteles.housekeeping_config set start_hour = $2 where property_id = $1 returning start_hour;`,
        [propertyId, patch.startHour],
      );
      return { ...saved, startHour: Number(hora[0]!.start_hour), startHourDisponible: true };
    });
  }

  listPhotos(propertyId: string, taskId: string) {
    return this.read<{ disponible: boolean; photos: readonly TaskPhotoRecord[] }>(
      async () => {
        const { rows } = await this.db.query<PhotoRow>(
          `select ${PHOTO_COLUMNS} from hoteles.housekeeping_task_photo where property_id = $1 and task_id = $2 order by created_at asc;`,
          [propertyId, taskId],
        );
        return { disponible: true, photos: rows.map(mapPhoto) };
      },
      () => ({ disponible: false, photos: [] }),
    );
  }

  countPhotos(propertyId: string, taskId: string): Promise<number> {
    return this.read(
      async () => {
        const { rows } = await this.db.query<{ n: string }>(`select count(*)::text as n from hoteles.housekeeping_task_photo where property_id = $1 and task_id = $2;`, [propertyId, taskId]);
        return Number(rows[0]?.n ?? 0);
      },
      () => 0,
    );
  }

  addPhoto(input: NewTaskPhotoInput): Promise<TaskPhotoRecord> {
    return this.write("addPhoto", async () => {
      const { rows } = await this.db.query<PhotoRow>(
        `insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data, caption, taken_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning ${PHOTO_COLUMNS};`,
        [input.propertyId, input.taskId, input.contentType, input.bytes.length, Buffer.from(input.bytes), input.caption, input.takenBy],
      );
      return mapPhoto(rows[0]!);
    });
  }

  getPhoto(propertyId: string, taskId: string, photoId: string) {
    return this.read<{ contentType: string; bytes: Uint8Array } | null>(
      async () => {
        const { rows } = await this.db.query<{ content_type: string; image_data: Buffer }>(
          `select content_type, image_data from hoteles.housekeeping_task_photo where id = $1 and task_id = $2 and property_id = $3;`,
          [photoId, taskId, propertyId],
        );
        return rows[0] ? { contentType: rows[0].content_type, bytes: new Uint8Array(rows[0].image_data) } : null;
      },
      () => null,
    );
  }

  deletePhoto(propertyId: string, taskId: string, photoId: string): Promise<boolean> {
    return this.write("deletePhoto", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `delete from hoteles.housekeeping_task_photo where id = $1 and task_id = $2 and property_id = $3 returning id;`,
        [photoId, taskId, propertyId],
      );
      return rows.length > 0;
    });
  }

  listLinen(propertyId: string, countDate: string) {
    return this.read<{ disponible: boolean; current: readonly LinenCountRecord[]; previous: readonly LinenCountRecord[] }>(
      async () => {
        const current = await this.db.query<LinenRow>(`select ${LINEN_COLUMNS} from hoteles.linen_count where property_id = $1 and count_date = $2::date order by item;`, [propertyId, countDate]);
        const previous = await this.db.query<LinenRow>(
          `select distinct on (item) ${LINEN_COLUMNS} from hoteles.linen_count where property_id = $1 and count_date < $2::date order by item, count_date desc;`,
          [propertyId, countDate],
        );
        return { disponible: true, current: current.rows.map(mapLinen), previous: previous.rows.map(mapLinen) };
      },
      () => ({ disponible: false, current: [], previous: [] }),
    );
  }

  saveLinen(input: LinenCountInput): Promise<LinenCountRecord> {
    return this.write("saveLinen", async () => {
      const { rows } = await this.db.query<LinenRow>(
        `insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty, qty_laundry, qty_damaged, counted_by)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8)
         on conflict (property_id, count_date, item) do update set qty_clean = excluded.qty_clean, qty_dirty = excluded.qty_dirty,
           qty_laundry = excluded.qty_laundry, qty_damaged = excluded.qty_damaged, counted_by = excluded.counted_by, updated_at = now()
         returning ${LINEN_COLUMNS};`,
        [input.propertyId, input.countDate, input.item, input.qtyClean, input.qtyDirty, input.qtyLaundry, input.qtyDamaged, input.countedBy],
      );
      return mapLinen(rows[0]!);
    });
  }

  listOptOuts(propertyId: string, optOutDate: string) {
    return this.read<{ disponible: boolean; optOuts: readonly CleaningOptOutRecord[] }>(
      async () => {
        const { rows } = await this.db.query<OptOutRow>(
          `select ${OPT_OUT_SELECT} from hoteles.cleaning_opt_out o join hoteles.room r on r.id = o.room_id
           where o.property_id = $1 and o.opt_out_date = $2::date order by r.code asc, o.created_at desc;`,
          [propertyId, optOutDate],
        );
        return { disponible: true, optOuts: rows.map(mapOptOut) };
      },
      () => ({ disponible: false, optOuts: [] }),
    );
  }

  registerOptOut(input: NewCleaningOptOutInput) {
    return this.write("registerOptOut", async () => {
      const room = await this.db.query<{ id: string }>(`select id from hoteles.room where id = $1 and property_id = $2;`, [input.roomId, input.propertyId]);
      if (!room.rows[0]) throw new HousekeepingNotFoundError("Habitacion");
      const inserted = await this.db.query<{ id: string }>(
        `insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date, source, note, created_by)
         values ($1, $2, $3::date, $4, $5, $6) returning id;`,
        [input.propertyId, input.roomId, input.optOutDate, input.source, input.note, input.createdBy],
      );
      const id = inserted.rows[0]!.id;
      const skippable: HousekeepingTaskType[] = ["estancia", "repaso"];
      const canceled = await this.db.query<{ id: string }>(
        `update hoteles.housekeeping_task set status = 'cancelada', updated_at = now()
         where property_id = $1 and room_id = $2 and work_date = $3::date and task_type = any($4::text[]) and status = 'pendiente' returning id;`,
        [input.propertyId, input.roomId, input.optOutDate, skippable],
      );
      const { rows } = await this.db.query<OptOutRow>(
        `select ${OPT_OUT_SELECT} from hoteles.cleaning_opt_out o join hoteles.room r on r.id = o.room_id where o.id = $1;`,
        [id],
      );
      return { optOut: mapOptOut(rows[0]!), tareasCanceladas: canceled.rows.length };
    });
  }

  revertOptOut(propertyId: string, optOutId: string, actorId: string): Promise<CleaningOptOutRecord | null> {
    return this.write("revertOptOut", async () => {
      const updated = await this.db.query<{ id: string }>(
        `update hoteles.cleaning_opt_out set status = 'revertido', reverted_by = $3, reverted_at = now()
         where id = $1 and property_id = $2 and status = 'activo' returning id;`,
        [optOutId, propertyId, actorId],
      );
      if (!updated.rows[0]) return null;
      const { rows } = await this.db.query<OptOutRow>(
        `select ${OPT_OUT_SELECT} from hoteles.cleaning_opt_out o join hoteles.room r on r.id = o.room_id where o.id = $1;`,
        [optOutId],
      );
      return mapOptOut(rows[0]!);
    });
  }

  hasActiveOptOut(propertyId: string, roomId: string, optOutDate: string): Promise<boolean> {
    return this.read(
      async () => {
        const { rows } = await this.db.query<{ one: number }>(
          `select 1 as one from hoteles.cleaning_opt_out where property_id = $1 and room_id = $2 and opt_out_date = $3::date and status = 'activo' limit 1;`,
          [propertyId, roomId, optOutDate],
        );
        return rows.length > 0;
      },
      () => false,
    );
  }
}
