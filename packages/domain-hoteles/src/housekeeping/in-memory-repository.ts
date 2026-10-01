// Espejo en memoria de PostgresHousekeepingRepository (H-04) para tests de ruta. NO emula
// RLS/GRANT/triggers (eso lo cubre scripts/verify-hoteles-housekeeping contra Postgres
// real); SI replica las reglas de negocio visibles (guardas de estado, una tarea activa
// por habitacion/dia/tipo, separacion de funciones, fuera de servicio) y la degradacion
// "base sin migrar" (`migrated: false`).
import { randomUUID } from "node:crypto";
import type { HousekeepingRepository } from "./repository.ts";
import {
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  canSetOutOfService,
  emptyRoomStatusCounts,
  inspectorIsAllowed,
  roomStatusAfterApprovedInspection,
  roomStatusForOutOfService,
  summarizeTasks,
} from "./tareas.ts";
import type {
  HotelRoomStatus,
  HousekeepingBoardResult,
  HousekeepingDailyReport,
  HousekeepingTaskFilter,
  HousekeepingTaskRecord,
  HousekeepingTaskStatus,
  NewHousekeepingTaskInput,
  NewOutOfServiceInput,
  OutOfServiceRecord,
} from "./tareas.ts";

interface StoredRoom { id: string; propertyId: string; code: string; roomType: string; status: HotelRoomStatus }

export class InMemoryHousekeepingRepository implements HousekeepingRepository {
  private readonly rooms = new Map<string, StoredRoom>();
  private readonly tasks = new Map<string, HousekeepingTaskRecord>();
  private readonly oos = new Map<string, OutOfServiceRecord>();
  private readonly staff = new Set<string>(); // `${propertyId}:${userId}`
  /** `false` simula una base SIN la migracion 033 (lecturas degradadas, escrituras 503). */
  migrated: boolean;

  constructor(opts: { readonly migrated?: boolean } = {}) {
    this.migrated = opts.migrated ?? true;
  }

  seedRoom(room: { id: string; propertyId: string; code: string; roomType?: string; status: HotelRoomStatus }): void {
    this.rooms.set(room.id, { id: room.id, propertyId: room.propertyId, code: room.code, roomType: room.roomType ?? "Estandar", status: room.status });
  }
  seedStaff(propertyId: string, userId: string): void {
    this.staff.add(`${propertyId}:${userId}`);
  }
  roomStatus(roomId: string): HotelRoomStatus | undefined {
    return this.rooms.get(roomId)?.status;
  }

  private requireMigrated(operation: string): void {
    if (!this.migrated) throw new HousekeepingUnavailableError(operation);
  }

  private activeTaskFor(roomId: string, workDate: string, taskType?: string): HousekeepingTaskRecord | undefined {
    return [...this.tasks.values()].find((t) => t.roomId === roomId && t.workDate === workDate && t.status !== "cancelada" && (!taskType || t.taskType === taskType));
  }

  private activeOos(roomId: string): OutOfServiceRecord | undefined {
    return [...this.oos.values()].find((o) => o.roomId === roomId && o.status === "activo");
  }

  async getBoard(propertyId: string, workDate: string): Promise<HousekeepingBoardResult> {
    const rooms = [...this.rooms.values()].filter((r) => r.propertyId === propertyId).sort((a, b) => a.code.localeCompare(b.code));
    return {
      tareasDisponibles: this.migrated,
      rows: rooms.map((r) => {
        const task = this.migrated ? this.activeTaskFor(r.id, workDate) : undefined;
        const o = this.migrated ? this.activeOos(r.id) : undefined;
        return {
          roomId: r.id,
          code: r.code,
          roomType: r.roomType,
          roomStatus: r.status,
          task: task ? { id: task.id, taskType: task.taskType, status: task.status, priority: task.priority, assignedTo: task.assignedTo, rejections: task.rejections } : null,
          outOfService: o ? { id: o.id, kind: o.kind, reason: o.reason, expectedReturnDate: o.expectedReturnDate } : null,
        };
      }),
    };
  }

  async generateDay(propertyId: string, workDate: string, createdBy: string): Promise<number> {
    this.requireMigrated("generateDay");
    let created = 0;
    for (const r of this.rooms.values()) {
      if (r.propertyId !== propertyId || (r.status !== "sucia" && r.status !== "ocupada")) continue;
      if (this.activeOos(r.id) || this.activeTaskFor(r.id, workDate)) continue;
      await this.createTask({ propertyId, roomId: r.id, taskType: r.status === "ocupada" ? "estancia" : "salida", priority: "normal", workDate, assignedTo: null, notes: null, createdBy });
      created += 1;
    }
    return created;
  }

  async createTask(input: NewHousekeepingTaskInput): Promise<HousekeepingTaskRecord> {
    this.requireMigrated("createTask");
    const room = this.rooms.get(input.roomId);
    if (!room || room.propertyId !== input.propertyId) throw new HousekeepingNotFoundError("Habitacion o responsable");
    if (input.assignedTo && !this.staff.has(`${input.propertyId}:${input.assignedTo}`)) {
      throw new HousekeepingInvalidInputError("El responsable no es staff de esta property.");
    }
    if (this.activeTaskFor(input.roomId, input.workDate, input.taskType)) throw new HousekeepingConflictError("Ya existe una tarea activa para esa habitacion.");
    const now = new Date().toISOString();
    const record: HousekeepingTaskRecord = {
      id: randomUUID(), propertyId: input.propertyId, roomId: input.roomId, roomCode: room.code, taskType: input.taskType, status: "pendiente",
      priority: input.priority, workDate: input.workDate, assignedTo: input.assignedTo, notes: input.notes, startedAt: null, finishedAt: null,
      inspectionResult: null, inspectedBy: null, inspectedAt: null, inspectionNote: null, rejections: 0, createdBy: input.createdBy, createdAt: now, updatedAt: now,
    };
    this.tasks.set(record.id, record);
    return record;
  }

  async findTask(propertyId: string, taskId: string): Promise<HousekeepingTaskRecord | null> {
    const t = this.tasks.get(taskId);
    return t && t.propertyId === propertyId ? t : null;
  }

  async listTasks(propertyId: string, filter: HousekeepingTaskFilter): Promise<readonly HousekeepingTaskRecord[]> {
    return [...this.tasks.values()]
      .filter((t) => t.propertyId === propertyId && t.workDate === filter.workDate && (!filter.status || t.status === filter.status) && (!filter.assignedTo || t.assignedTo === filter.assignedTo))
      .sort((a, b) => a.roomCode.localeCompare(b.roomCode));
  }

  private update(propertyId: string, taskId: string, from: readonly HousekeepingTaskStatus[], patch: Partial<HousekeepingTaskRecord>): HousekeepingTaskRecord | null {
    this.requireMigrated("updateTask");
    const t = this.tasks.get(taskId);
    if (!t || t.propertyId !== propertyId || !from.includes(t.status)) return null;
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(taskId, next);
    return next;
  }

  async startTask(propertyId: string, taskId: string, actorId: string) {
    const t = this.tasks.get(taskId);
    return this.update(propertyId, taskId, ["pendiente"], { status: "en_progreso", startedAt: new Date().toISOString(), assignedTo: t?.assignedTo ?? actorId });
  }
  async finishTask(propertyId: string, taskId: string) {
    return this.update(propertyId, taskId, ["en_progreso"], { status: "terminada", finishedAt: new Date().toISOString() });
  }
  async inspectTask(propertyId: string, taskId: string, input: { readonly inspectorId: string; readonly approved: boolean; readonly note: string | null }) {
    this.requireMigrated("inspectTask");
    const t = this.tasks.get(taskId);
    if (t && t.propertyId === propertyId && t.status === "terminada" && !inspectorIsAllowed(input.inspectorId, t.assignedTo)) {
      throw new HousekeepingInvalidInputError("Quien limpio no puede inspeccionar su propio trabajo.");
    }
    const now = new Date().toISOString();
    const updated = input.approved
      ? this.update(propertyId, taskId, ["terminada"], { status: "inspeccionada", inspectionResult: "aprobada", inspectedBy: input.inspectorId, inspectedAt: now, inspectionNote: input.note })
      : this.update(propertyId, taskId, ["terminada"], {
          status: "pendiente", inspectionResult: "rechazada", inspectedBy: input.inspectorId, inspectedAt: now, inspectionNote: input.note,
          rejections: (t?.rejections ?? 0) + 1, startedAt: null, finishedAt: null,
        });
    if (updated && input.approved) {
      const room = this.rooms.get(updated.roomId);
      if (room) room.status = roomStatusAfterApprovedInspection(room.status);
    }
    return updated;
  }
  async assignTask(propertyId: string, taskId: string, assignedTo: string) {
    this.requireMigrated("assignTask");
    if (!this.staff.has(`${propertyId}:${assignedTo}`)) throw new HousekeepingInvalidInputError("El responsable no es staff de esta property.");
    return this.update(propertyId, taskId, ["pendiente", "en_progreso"], { assignedTo });
  }
  async cancelTask(propertyId: string, taskId: string) {
    return this.update(propertyId, taskId, ["pendiente", "en_progreso", "terminada"], { status: "cancelada" });
  }

  async findRoom(propertyId: string, roomId: string) {
    const r = this.rooms.get(roomId);
    return r && r.propertyId === propertyId ? { id: r.id, code: r.code, status: r.status } : null;
  }
  async markRoomDirty(propertyId: string, roomId: string): Promise<HotelRoomStatus | null> {
    this.requireMigrated("markRoomDirty");
    const r = this.rooms.get(roomId);
    if (!r || r.propertyId !== propertyId || (r.status !== "disponible" && r.status !== "ocupada")) return null;
    r.status = "sucia";
    return r.status;
  }

  async markRoomOccupied(propertyId: string, roomId: string): Promise<HotelRoomStatus | null> {
    this.requireMigrated("markRoomOccupied");
    const r = this.rooms.get(roomId);
    if (!r || r.propertyId !== propertyId || r.status !== "disponible") return null;
    r.status = "ocupada";
    return r.status;
  }

  async listOutOfService(propertyId: string, onlyActive: boolean): Promise<readonly OutOfServiceRecord[]> {
    if (!this.migrated) return [];
    return [...this.oos.values()].filter((o) => o.propertyId === propertyId && (!onlyActive || o.status === "activo")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async setOutOfService(input: NewOutOfServiceInput): Promise<OutOfServiceRecord> {
    this.requireMigrated("setOutOfService");
    const room = this.rooms.get(input.roomId);
    if (!room || room.propertyId !== input.propertyId) throw new HousekeepingNotFoundError("Habitacion");
    if (!canSetOutOfService(room.status)) throw new HousekeepingConflictError("La habitacion esta ocupada: espera al check-out para inhabilitarla.");
    if (this.activeOos(input.roomId)) throw new HousekeepingConflictError("Ya existe una tarea activa (o inhabilitacion activa) para esa habitacion.");
    if (input.expectedReturnDate && input.expectedReturnDate < input.fromDate) throw new HousekeepingInvalidInputError("expectedReturnDate no puede ser anterior a fromDate.");
    const record: OutOfServiceRecord = {
      id: randomUUID(), propertyId: input.propertyId, roomId: input.roomId, roomCode: room.code, kind: input.kind, reason: input.reason,
      fromDate: input.fromDate, expectedReturnDate: input.expectedReturnDate, status: "activo", maintenanceTicketId: input.maintenanceTicketId,
      createdBy: input.createdBy, closedBy: null, closedAt: null, createdAt: new Date().toISOString(),
    };
    this.oos.set(record.id, record);
    room.status = roomStatusForOutOfService(input.kind);
    return record;
  }
  async returnToService(propertyId: string, outOfServiceId: string, actorId: string): Promise<OutOfServiceRecord | null> {
    this.requireMigrated("returnToService");
    const o = this.oos.get(outOfServiceId);
    if (!o || o.propertyId !== propertyId || o.status !== "activo") return null;
    const closed: OutOfServiceRecord = { ...o, status: "cerrado", closedBy: actorId, closedAt: new Date().toISOString() };
    this.oos.set(o.id, closed);
    const room = this.rooms.get(o.roomId);
    if (room && (room.status === "fuera_de_servicio" || room.status === "mantenimiento")) room.status = "sucia";
    return closed;
  }

  async dailyReport(propertyId: string, workDate: string): Promise<HousekeepingDailyReport> {
    const counts = emptyRoomStatusCounts();
    for (const r of this.rooms.values()) if (r.propertyId === propertyId) counts[r.status] += 1;
    const tasks = this.migrated ? [...this.tasks.values()].filter((t) => t.propertyId === propertyId && t.workDate === workDate) : [];
    return {
      tareasDisponibles: this.migrated,
      workDate,
      ...summarizeTasks(tasks),
      habitacionesPorEstado: counts,
      fueraDeServicioActivas: this.migrated ? [...this.oos.values()].filter((o) => o.propertyId === propertyId && o.status === "activo").length : 0,
    };
  }
}
