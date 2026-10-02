// Puerto de persistencia del housekeeping residual (H-26). Separado de HousekeepingRepository (H-04) para no
// ensanchar ese puerto. Contra una base SIN la migracion 039: las lecturas devuelven `disponible: false` con
// valores por defecto / listas vacias y las escrituras lanzan HousekeepingUnavailableError (503), nunca un 500.
import type {
  CleaningOptOutRecord,
  HousekeepingConfig,
  HousekeepingConfigPatch,
  LinenCountInput,
  LinenCountRecord,
  NewCleaningOptOutInput,
  NewTaskPhotoInput,
  TaskPhotoRecord,
} from "./residual.ts";

export interface HousekeepingResidualRepository {
  getConfig(propertyId: string): Promise<{ readonly disponible: boolean; readonly config: HousekeepingConfig }>;
  /** Guarda la configuracion (crea la fila si no existe). */
  saveConfig(propertyId: string, patch: HousekeepingConfigPatch, actorId: string): Promise<HousekeepingConfig>;

  listPhotos(propertyId: string, taskId: string): Promise<{ readonly disponible: boolean; readonly photos: readonly TaskPhotoRecord[] }>;
  countPhotos(propertyId: string, taskId: string): Promise<number>;
  addPhoto(input: NewTaskPhotoInput): Promise<TaskPhotoRecord>;
  getPhoto(propertyId: string, taskId: string, photoId: string): Promise<{ readonly contentType: string; readonly bytes: Uint8Array } | null>;
  /** `false` si la foto no existia en esa tarea/property. */
  deletePhoto(propertyId: string, taskId: string, photoId: string): Promise<boolean>;

  /** Conteos del dia y, por articulo, el ultimo conteo ANTERIOR (para detectar faltantes). */
  listLinen(propertyId: string, countDate: string): Promise<{ readonly disponible: boolean; readonly current: readonly LinenCountRecord[]; readonly previous: readonly LinenCountRecord[] }>;
  /** Un renglon por (property, dia, articulo): un segundo conteo del mismo dia lo corrige. */
  saveLinen(input: LinenCountInput): Promise<LinenCountRecord>;

  listOptOuts(propertyId: string, optOutDate: string): Promise<{ readonly disponible: boolean; readonly optOuts: readonly CleaningOptOutRecord[] }>;
  /** Registra el opt-out y cancela las tareas PENDIENTES de estancia/repaso de esa habitacion y dia (misma transaccion). */
  registerOptOut(input: NewCleaningOptOutInput): Promise<{ readonly optOut: CleaningOptOutRecord; readonly tareasCanceladas: number }>;
  /** `null` si no habia un opt-out activo con ese id en la property. */
  revertOptOut(propertyId: string, optOutId: string, actorId: string): Promise<CleaningOptOutRecord | null>;
  /** Vacio honesto (false) si la migracion 039 no esta aplicada. */
  hasActiveOptOut(propertyId: string, roomId: string, optOutDate: string): Promise<boolean>;
}
