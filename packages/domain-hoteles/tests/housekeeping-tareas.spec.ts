// H-04 -- reglas PURAS del housekeeping completo (tareas.ts) + espejo en memoria.
import { describe, expect, it } from "vitest";
import {
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingUnavailableError,
  InMemoryHousekeepingRepository,
  actorMayOperateTask,
  assertTaskAction,
  canApplyTaskAction,
  canSetOutOfService,
  inspectorIsAllowed,
  isIsoDate,
  roomStatusAfterApprovedInspection,
  roomStatusForOutOfService,
  summarizeTasks,
} from "../src/index.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const ROOM_A = "00000000-0000-0000-0000-0000000000b1";
const ROOM_B = "00000000-0000-0000-0000-0000000000b2";
const CAMARISTA = "00000000-0000-0000-0000-0000000000c1";
const SUPERVISOR = "00000000-0000-0000-0000-0000000000c2";

describe("reglas puras", () => {
  it("el ciclo de una tarea solo avanza por las transiciones permitidas", () => {
    expect(canApplyTaskAction("pendiente", "iniciar")).toBe(true);
    expect(canApplyTaskAction("en_progreso", "iniciar")).toBe(false);
    expect(canApplyTaskAction("en_progreso", "terminar")).toBe(true);
    expect(canApplyTaskAction("pendiente", "terminar")).toBe(false);
    expect(canApplyTaskAction("terminada", "inspeccionar")).toBe(true);
    expect(canApplyTaskAction("en_progreso", "inspeccionar")).toBe(false);
    expect(canApplyTaskAction("inspeccionada", "cancelar")).toBe(false);
    expect(() => assertTaskAction("cancelada", "iniciar")).toThrow(HousekeepingConflictError);
  });

  it("la camarista solo opera tareas propias o sin asignar; supervision opera cualquiera", () => {
    expect(actorMayOperateTask("housekeeping", CAMARISTA, CAMARISTA)).toBe(true);
    expect(actorMayOperateTask("housekeeping", CAMARISTA, null)).toBe(true);
    expect(actorMayOperateTask("housekeeping", CAMARISTA, SUPERVISOR)).toBe(false);
    expect(actorMayOperateTask("frontdesk", SUPERVISOR, CAMARISTA)).toBe(true);
  });

  it("quien limpio no inspecciona su propio trabajo", () => {
    expect(inspectorIsAllowed(CAMARISTA, CAMARISTA)).toBe(false);
    expect(inspectorIsAllowed(SUPERVISOR, CAMARISTA)).toBe(true);
    expect(inspectorIsAllowed(SUPERVISOR, null)).toBe(true);
  });

  it("estado de habitacion: inspeccion aprobada libera solo una sucia; fuera de orden usa mantenimiento", () => {
    expect(roomStatusAfterApprovedInspection("sucia")).toBe("disponible");
    expect(roomStatusAfterApprovedInspection("ocupada")).toBe("ocupada");
    expect(roomStatusAfterApprovedInspection("fuera_de_servicio")).toBe("fuera_de_servicio");
    expect(roomStatusForOutOfService("fuera_de_orden")).toBe("mantenimiento");
    expect(roomStatusForOutOfService("fuera_de_servicio")).toBe("fuera_de_servicio");
    expect(canSetOutOfService("ocupada")).toBe(false);
    expect(canSetOutOfService("sucia")).toBe(true);
  });

  it("isIsoDate rechaza fechas imposibles", () => {
    expect(isIsoDate("2026-03-10")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("10/03/2026")).toBe(false);
    expect(isIsoDate(20260310)).toBe(false);
  });

  it("summarizeTasks agrega por responsable, ignora canceladas y promedia minutos reales", () => {
    const base = { rejections: 0, startedAt: null, finishedAt: null };
    const r = summarizeTasks([
      { ...base, status: "inspeccionada", assignedTo: CAMARISTA, startedAt: "2026-03-10T10:00:00Z", finishedAt: "2026-03-10T10:30:00Z" },
      { ...base, status: "terminada", assignedTo: CAMARISTA, rejections: 1, startedAt: "2026-03-10T11:00:00Z", finishedAt: "2026-03-10T11:20:00Z" },
      { ...base, status: "pendiente", assignedTo: null },
      { ...base, status: "cancelada", assignedTo: CAMARISTA },
    ]);
    expect(r.totales).toEqual({ total: 3, pendientes: 1, enProgreso: 0, porInspeccionar: 1, inspeccionadas: 1, rechazos: 1 });
    const cam = r.porResponsable.find((x) => x.assignedTo === CAMARISTA)!;
    expect(cam).toMatchObject({ total: 2, minutosPromedio: 25 });
    expect(r.porResponsable.find((x) => x.assignedTo === null)!.minutosPromedio).toBeNull();
  });
});

function seeded(opts?: { migrated?: boolean }) {
  const repo = new InMemoryHousekeepingRepository(opts);
  repo.seedRoom({ id: ROOM_A, propertyId: P, code: "101", status: "sucia" });
  repo.seedRoom({ id: ROOM_B, propertyId: P, code: "102", status: "ocupada" });
  repo.seedStaff(P, CAMARISTA);
  repo.seedStaff(P, SUPERVISOR);
  return repo;
}

describe("InMemoryHousekeepingRepository", () => {
  it("generar el dia crea tareas para sucias/ocupadas, es idempotente y salta fuera de servicio", async () => {
    const repo = seeded();
    expect(await repo.generateDay(P, "2026-03-10", SUPERVISOR)).toBe(2);
    expect(await repo.generateDay(P, "2026-03-10", SUPERVISOR)).toBe(0);
    const tasks = await repo.listTasks(P, { workDate: "2026-03-10" });
    expect(tasks.map((t) => [t.roomCode, t.taskType])).toEqual([["101", "salida"], ["102", "estancia"]]);
  });

  it("ciclo completo: iniciar (toma la tarea), terminar, inspeccion aprobada libera la habitacion", async () => {
    const repo = seeded();
    await repo.generateDay(P, "2026-03-10", SUPERVISOR);
    const [task] = await repo.listTasks(P, { workDate: "2026-03-10", status: "pendiente" });
    const started = await repo.startTask(P, task!.id, CAMARISTA);
    expect(started).toMatchObject({ status: "en_progreso", assignedTo: CAMARISTA });
    expect(await repo.startTask(P, task!.id, CAMARISTA)).toBeNull();
    expect((await repo.finishTask(P, task!.id))?.status).toBe("terminada");
    await expect(repo.inspectTask(P, task!.id, { inspectorId: CAMARISTA, approved: true, note: null })).rejects.toBeInstanceOf(HousekeepingInvalidInputError);
    const done = await repo.inspectTask(P, task!.id, { inspectorId: SUPERVISOR, approved: true, note: "ok" });
    expect(done).toMatchObject({ status: "inspeccionada", inspectionResult: "aprobada" });
    expect(repo.roomStatus(ROOM_A)).toBe("disponible");
  });

  it("inspeccion rechazada devuelve la tarea a pendiente con rejections + 1 y deja la habitacion sucia", async () => {
    const repo = seeded();
    await repo.generateDay(P, "2026-03-10", SUPERVISOR);
    const [task] = await repo.listTasks(P, { workDate: "2026-03-10", status: "pendiente" });
    await repo.startTask(P, task!.id, CAMARISTA);
    await repo.finishTask(P, task!.id);
    const rejected = await repo.inspectTask(P, task!.id, { inspectorId: SUPERVISOR, approved: false, note: "Falta polvo" });
    expect(rejected).toMatchObject({ status: "pendiente", rejections: 1, inspectionResult: "rechazada", startedAt: null, finishedAt: null });
    expect(repo.roomStatus(ROOM_A)).toBe("sucia");
  });

  it("fuera de servicio: no inhabilita una ocupada, bloquea el generar-dia y al rehabilitar regresa a sucia", async () => {
    const repo = seeded();
    const input = { propertyId: P, roomId: ROOM_A, kind: "fuera_de_orden" as const, reason: "Fuga en bano", fromDate: "2026-03-10", expectedReturnDate: null, maintenanceTicketId: null, createdBy: SUPERVISOR };
    await expect(repo.setOutOfService({ ...input, roomId: ROOM_B })).rejects.toBeInstanceOf(HousekeepingConflictError);
    const oos = await repo.setOutOfService(input);
    expect(repo.roomStatus(ROOM_A)).toBe("mantenimiento");
    await expect(repo.setOutOfService(input)).rejects.toBeInstanceOf(HousekeepingConflictError);
    expect(await repo.generateDay(P, "2026-03-10", SUPERVISOR)).toBe(1); // solo la 102
    expect((await repo.getBoard(P, "2026-03-10")).rows.find((r) => r.roomId === ROOM_A)?.outOfService?.reason).toBe("Fuga en bano");
    const closed = await repo.returnToService(P, oos.id, SUPERVISOR);
    expect(closed?.status).toBe("cerrado");
    expect(repo.roomStatus(ROOM_A)).toBe("sucia");
    expect(await repo.returnToService(P, oos.id, SUPERVISOR)).toBeNull();
  });

  it("base sin migrar: tablero solo con estado de habitacion, reporte vacio, escrituras 503", async () => {
    const repo = seeded({ migrated: false });
    const board = await repo.getBoard(P, "2026-03-10");
    expect(board.tareasDisponibles).toBe(false);
    expect(board.rows.map((r) => r.roomStatus)).toEqual(["sucia", "ocupada"]);
    expect(board.rows.every((r) => r.task === null && r.outOfService === null)).toBe(true);
    expect((await repo.dailyReport(P, "2026-03-10")).tareasDisponibles).toBe(false);
    expect(await repo.listOutOfService(P, true)).toEqual([]);
    await expect(repo.generateDay(P, "2026-03-10", SUPERVISOR)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
  });
});
