// Puerto de persistencia del housekeeping completo (H-04). Separado de `HotelesRepository`
// (mismo criterio que la boveda de identidad, H-01) para no ensanchar el puerto grande.
// Todas las transiciones llevan guarda de estado en SQL (`where status = ...`): devuelven
// `null` si la tarea ya no estaba en el estado esperado (carrera perdida) y el llamador
// decide 404 vs 409.
import type {
  HotelRoomStatus,
  HousekeepingBoardResult,
  HousekeepingDailyReport,
  HousekeepingTaskFilter,
  HousekeepingTaskRecord,
  NewHousekeepingTaskInput,
  NewOutOfServiceInput,
  OutOfServiceRecord,
} from "./tareas.ts";

export interface HousekeepingRepository {
  /** Tablero del dia: una fila por habitacion. Degrada a solo-estado de habitacion
   *  (`tareasDisponibles: false`) si la migracion 033 no esta aplicada. */
  getBoard(propertyId: string, workDate: string): Promise<HousekeepingBoardResult>;
  /** Crea las tareas del dia para habitaciones `sucia`/`ocupada` sin tarea activa y sin
   *  inhabilitacion activa. Idempotente. Devuelve cuantas creo. `skipStayRoomIds` (H-26): habitaciones con opt-out
   *  de limpieza activo ese dia; a esas NO se les genera la tarea de estancia (la de salida si se genera). */
  generateDay(propertyId: string, workDate: string, createdBy: string, skipStayRoomIds?: readonly string[]): Promise<number>;
  createTask(input: NewHousekeepingTaskInput): Promise<HousekeepingTaskRecord>;
  findTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null>;
  /** Vacio honesto si la migracion 033 no esta aplicada. */
  listTasks(propertyId: string, filter: HousekeepingTaskFilter): Promise<readonly HousekeepingTaskRecord[]>;
  /** pendiente -> en_progreso; si no tenia responsable, queda a nombre de `actorId`. */
  startTask(propertyId: string, taskId: string, actorId: string): Promise<HousekeepingTaskRecord | null>;
  /** en_progreso -> terminada (espera inspeccion). */
  finishTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null>;
  /** terminada -> inspeccionada (aprobada, libera la habitacion `sucia`) o -> pendiente
   *  (rechazada, rejections + 1), todo en la misma transaccion. */
  inspectTask(
    propertyId: string,
    taskId: string,
    input: { readonly inspectorId: string; readonly approved: boolean; readonly note: string | null },
  ): Promise<HousekeepingTaskRecord | null>;
  assignTask(propertyId: string, taskId: string, assignedTo: string): Promise<HousekeepingTaskRecord | null>;
  cancelTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null>;

  findRoom(propertyId: string, roomId: string): Promise<{ readonly id: string; readonly code: string; readonly status: HotelRoomStatus } | null>;
  /** disponible/ocupada -> sucia (p. ej. tras un check-out). `null` si no aplica. */
  markRoomDirty(propertyId: string, roomId: string): Promise<HotelRoomStatus | null>;
  /** disponible -> ocupada (check-in: el huesped ya esta en la habitacion, por lo que el dia genera tareas de estancia).
   *  `null` si la habitacion no estaba `disponible` (sucia, fuera de servicio, ya ocupada). */
  markRoomOccupied(propertyId: string, roomId: string): Promise<HotelRoomStatus | null>;

  listOutOfService(propertyId: string, onlyActive: boolean): Promise<readonly OutOfServiceRecord[]>;
  /** Inhabilita la habitacion (registro + room.status) en una sola transaccion. */
  setOutOfService(input: NewOutOfServiceInput): Promise<OutOfServiceRecord>;
  /** Cierra la inhabilitacion; la habitacion regresa a `sucia` (debe limpiarse e inspeccionarse). */
  returnToService(propertyId: string, outOfServiceId: string, actorId: string): Promise<OutOfServiceRecord | null>;

  dailyReport(propertyId: string, workDate: string): Promise<HousekeepingDailyReport>;
}
