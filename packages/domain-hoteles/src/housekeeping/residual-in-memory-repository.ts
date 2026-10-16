// Espejo en memoria de PostgresHousekeepingResidualRepository (H-26) para tests de ruta. NO emula RLS/GRANT/triggers
// (eso lo cubre scripts/verify-hoteles-hk-canal contra Postgres real); SI replica las reglas visibles: tope de fotos
// por tarea, una cuenta de blancos por (dia, articulo), un opt-out activo por (habitacion, dia), cancelacion de las
// tareas pendientes de estancia/repaso al registrar un opt-out y la degradacion "base sin migrar" (`migrated: false`).
import { randomUUID } from "node:crypto";
import type { InMemoryHousekeepingRepository } from "./in-memory-repository.ts";
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
  type NewCleaningOptOutInput,
  type NewTaskPhotoInput,
  type TaskPhotoRecord,
} from "./residual.ts";
import { OPT_OUT_SKIPPABLE_TASK_TYPES } from "./residual.ts";
import { HousekeepingConflictError, HousekeepingNotFoundError, HousekeepingUnavailableError } from "./tareas.ts";

interface StoredPhoto extends TaskPhotoRecord { readonly propertyId: string; readonly bytes: Uint8Array }

export class InMemoryHousekeepingResidualRepository implements HousekeepingResidualRepository {
  private readonly configs = new Map<string, HousekeepingConfig>();
  private readonly photos = new Map<string, StoredPhoto>();
  private readonly linen = new Map<string, LinenCountRecord & { propertyId: string }>();
  private readonly optOuts = new Map<string, CleaningOptOutRecord & { propertyId: string }>();
  /** `false` simula una base SIN la migracion 039 (lecturas degradadas, escrituras 503). */
  migrated: boolean;

  /** `hk` (opcional): el repo de tareas contra el que el opt-out cancela las tareas pendientes. */
  constructor(private readonly hk?: InMemoryHousekeepingRepository, opts: { readonly migrated?: boolean } = {}) {
    this.migrated = opts.migrated ?? true;
  }

  private requireMigrated(operation: string): void {
    if (!this.migrated) throw new HousekeepingUnavailableError(operation);
  }

  private defaultConfig(propertyId: string): HousekeepingConfig {
    return { propertyId, ...DEFAULT_HOUSEKEEPING_CONFIG, startHourDisponible: this.migrated, personalizada: false, updatedAt: null };
  }

  async getConfig(propertyId: string) {
    if (!this.migrated) return { disponible: false, config: this.defaultConfig(propertyId) };
    return { disponible: true, config: this.configs.get(propertyId) ?? this.defaultConfig(propertyId) };
  }

  async saveConfig(propertyId: string, patch: HousekeepingConfigPatch, _actorId: string): Promise<HousekeepingConfig> {
    this.requireMigrated("saveConfig");
    const current = this.configs.get(propertyId) ?? this.defaultConfig(propertyId);
    const base: HousekeepingConfigValues = current;
    const next: HousekeepingConfig = { propertyId, ...mergeHousekeepingConfig(base, patch), startHourDisponible: true, personalizada: true, updatedAt: new Date().toISOString() };
    this.configs.set(propertyId, next);
    return next;
  }

  async listPhotos(propertyId: string, taskId: string) {
    if (!this.migrated) return { disponible: false, photos: [] };
    const photos = [...this.photos.values()].filter((p) => p.propertyId === propertyId && p.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { disponible: true, photos: photos.map(({ propertyId: _p, bytes: _b, ...rest }) => rest) };
  }

  async countPhotos(propertyId: string, taskId: string): Promise<number> {
    if (!this.migrated) return 0;
    return [...this.photos.values()].filter((p) => p.propertyId === propertyId && p.taskId === taskId).length;
  }

  async addPhoto(input: NewTaskPhotoInput): Promise<TaskPhotoRecord> {
    this.requireMigrated("addPhoto");
    const task = this.hk ? await this.hk.findTask(input.propertyId, input.taskId) : null;
    if (this.hk && !task) throw new HousekeepingNotFoundError("Tarea o habitacion");
    if (task?.status === "cancelada") throw new HousekeepingConflictError("La tarea ya tiene el maximo de fotos, esta cancelada o los datos no son validos.");
    const max = (this.configs.get(input.propertyId) ?? this.defaultConfig(input.propertyId)).maxPhotosPerTask;
    if ((await this.countPhotos(input.propertyId, input.taskId)) >= max) throw new HousekeepingConflictError("La tarea ya tiene el maximo de fotos, esta cancelada o los datos no son validos.");
    const record: StoredPhoto = {
      id: randomUUID(), propertyId: input.propertyId, taskId: input.taskId, contentType: input.contentType, byteSize: input.bytes.length,
      caption: input.caption, takenBy: input.takenBy, createdAt: new Date().toISOString(), bytes: input.bytes,
    };
    this.photos.set(record.id, record);
    const { propertyId: _p, bytes: _b, ...rest } = record;
    return rest;
  }

  async getPhoto(propertyId: string, taskId: string, photoId: string) {
    if (!this.migrated) return null;
    const p = this.photos.get(photoId);
    return p && p.propertyId === propertyId && p.taskId === taskId ? { contentType: p.contentType, bytes: p.bytes } : null;
  }

  async deletePhoto(propertyId: string, taskId: string, photoId: string): Promise<boolean> {
    this.requireMigrated("deletePhoto");
    const p = this.photos.get(photoId);
    if (!p || p.propertyId !== propertyId || p.taskId !== taskId) return false;
    this.photos.delete(photoId);
    return true;
  }

  async listLinen(propertyId: string, countDate: string) {
    if (!this.migrated) return { disponible: false, current: [], previous: [] };
    const all = [...this.linen.values()].filter((l) => l.propertyId === propertyId);
    const strip = ({ propertyId: _p, ...rest }: LinenCountRecord & { propertyId: string }): LinenCountRecord => rest;
    const current = all.filter((l) => l.countDate === countDate).map(strip);
    const latest = new Map<string, LinenCountRecord>();
    for (const l of all.filter((x) => x.countDate < countDate).sort((a, b) => a.countDate.localeCompare(b.countDate))) latest.set(l.item, strip(l));
    return { disponible: true, current, previous: [...latest.values()] };
  }

  async saveLinen(input: LinenCountInput): Promise<LinenCountRecord> {
    this.requireMigrated("saveLinen");
    const record = {
      propertyId: input.propertyId, item: input.item, countDate: input.countDate, qtyClean: input.qtyClean, qtyDirty: input.qtyDirty,
      qtyLaundry: input.qtyLaundry, qtyDamaged: input.qtyDamaged, countedBy: input.countedBy, updatedAt: new Date().toISOString(),
    };
    this.linen.set(`${input.propertyId}:${input.countDate}:${input.item}`, record);
    const { propertyId: _p, ...rest } = record;
    return rest;
  }

  async listOptOuts(propertyId: string, optOutDate: string) {
    if (!this.migrated) return { disponible: false, optOuts: [] };
    const rows = [...this.optOuts.values()].filter((o) => o.propertyId === propertyId && o.optOutDate === optOutDate).sort((a, b) => a.roomCode.localeCompare(b.roomCode, "es", { numeric: true }));
    return { disponible: true, optOuts: rows.map(({ propertyId: _p, ...rest }) => rest) };
  }

  async registerOptOut(input: NewCleaningOptOutInput) {
    this.requireMigrated("registerOptOut");
    const room = this.hk ? await this.hk.findRoom(input.propertyId, input.roomId) : { id: input.roomId, code: "?", status: "ocupada" as const };
    if (!room) throw new HousekeepingNotFoundError("Habitacion");
    if (await this.hasActiveOptOut(input.propertyId, input.roomId, input.optOutDate)) {
      throw new HousekeepingConflictError("Ya existe un registro activo para esa habitacion y fecha.");
    }
    let canceladas = 0;
    if (this.hk) {
      const tasks = await this.hk.listTasks(input.propertyId, { workDate: input.optOutDate });
      for (const t of tasks) {
        if (t.roomId === input.roomId && t.status === "pendiente" && OPT_OUT_SKIPPABLE_TASK_TYPES.includes(t.taskType)) {
          if (await this.hk.cancelTask(input.propertyId, t.id)) canceladas += 1;
        }
      }
    }
    const record = {
      propertyId: input.propertyId, id: randomUUID(), roomId: input.roomId, roomCode: room.code, optOutDate: input.optOutDate, source: input.source,
      note: input.note, status: "activo" as const, createdBy: input.createdBy, createdAt: new Date().toISOString(), revertedAt: null,
    };
    this.optOuts.set(record.id, record);
    const { propertyId: _p, ...rest } = record;
    return { optOut: rest, tareasCanceladas: canceladas };
  }

  async revertOptOut(propertyId: string, optOutId: string, _actorId: string): Promise<CleaningOptOutRecord | null> {
    this.requireMigrated("revertOptOut");
    const o = this.optOuts.get(optOutId);
    if (!o || o.propertyId !== propertyId || o.status !== "activo") return null;
    const reverted = { ...o, status: "revertido" as const, revertedAt: new Date().toISOString() };
    this.optOuts.set(optOutId, reverted);
    const { propertyId: _p, ...rest } = reverted;
    return rest;
  }

  async hasActiveOptOut(propertyId: string, roomId: string, optOutDate: string): Promise<boolean> {
    if (!this.migrated) return false;
    return [...this.optOuts.values()].some((o) => o.propertyId === propertyId && o.roomId === roomId && o.optOutDate === optOutDate && o.status === "activo");
  }
}
