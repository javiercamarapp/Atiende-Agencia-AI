// H-04 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar contra
// PostgresHousekeepingRepository REAL + AbortAwareFakeSession (reproduce el estado
// ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta posterior
// lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test
// FALLA si se quita el SAVEPOINT: la consulta de respaldo / la siguiente consulta del
// request lanzaria 25P02 en vez de resolver.
import { describe, expect, it } from "vitest";
import { HousekeepingAccessDeniedError, HousekeepingNotFoundError, HousekeepingUnavailableError, PostgresHousekeepingRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const ROOM = "00000000-0000-0000-0000-0000000000b1";
const U = "00000000-0000-0000-0000-0000000000c1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedTable = () => pgError("42P01", 'relation "hoteles.housekeeping_task" does not exist');

describe("lecturas con base sin migrar 033 (42P01)", () => {
  it("getBoard degrada al tablero solo-estado y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /left join lateral/i, respond: undefinedTable },
      { match: /from hoteles\.room r join hoteles\.room_type rt/i, respond: () => [{ room_id: ROOM, code: "101", room_status: "sucia", room_type_name: "Doble" }] },
      { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresHousekeepingRepository(session);
    const board = await repo.getBoard(P, "2026-03-10");
    expect(board).toEqual({ tareasDisponibles: false, rows: [{ roomId: ROOM, code: "101", roomType: "Doble", roomStatus: "sucia", task: null, outOfService: null }] });
    // la MISMA transaccion sigue sirviendo consultas (sin ROLLBACK TO SAVEPOINT lanzaria 25P02)
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("listTasks y listOutOfService devuelven vacio honesto", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.housekeeping_task t/i, respond: undefinedTable },
      { match: /from hoteles\.room_out_of_service o/i, respond: () => pgError("42P01", "no existe") },
    ]);
    const repo = new PostgresHousekeepingRepository(session);
    expect(await repo.listTasks(P, { workDate: "2026-03-10" })).toEqual([]);
    expect(await repo.listOutOfService(P, true)).toEqual([]);
  });

  it("dailyReport degrada a conteos de habitacion con tareasDisponibles:false", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.housekeeping_task t/i, respond: undefinedTable },
      { match: /from hoteles\.room where property_id = \$1 group by status/i, respond: () => [{ status: "sucia", n: "3" }, { status: "disponible", n: "5" }] },
    ]);
    const report = await new PostgresHousekeepingRepository(session).dailyReport(P, "2026-03-10");
    expect(report.tareasDisponibles).toBe(false);
    expect(report.totales.total).toBe(0);
    expect(report.habitacionesPorEstado).toMatchObject({ sucia: 3, disponible: 5, ocupada: 0 });
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /left join lateral/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresHousekeepingRepository(session).getBoard(P, "2026-03-10")).rejects.toMatchObject({ code: "57014" });
  });
});

describe("escrituras: errores de Postgres -> errores de dominio, con la sesion recuperada", () => {
  it("generateDay sin migracion 033 -> HousekeepingUnavailableError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into hoteles\.housekeeping_task/i, respond: undefinedTable },
      { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresHousekeepingRepository(session).generateDay(P, "2026-03-10", U)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("FK compuesta (23503) -> NotFound; permission denied (42501) -> AccessDenied", async () => {
    const fk = new AbortAwareFakeSession([{ match: /insert into hoteles\.housekeeping_task/i, respond: () => pgError("23503", "fk") }]);
    await expect(
      new PostgresHousekeepingRepository(fk).createTask({ propertyId: P, roomId: ROOM, taskType: "salida", priority: "normal", workDate: "2026-03-10", assignedTo: null, notes: null, createdBy: U }),
    ).rejects.toBeInstanceOf(HousekeepingNotFoundError);
    const denied = new AbortAwareFakeSession([{ match: /update hoteles\.room set status = 'sucia'/i, respond: () => pgError("42501", "permission denied") }]);
    await expect(new PostgresHousekeepingRepository(denied).markRoomDirty(P, ROOM)).rejects.toBeInstanceOf(HousekeepingAccessDeniedError);
  });

  it("inspectTask: si la liberacion de la habitacion falla, el SAVEPOINT revierte TODA la inspeccion", async () => {
    const taskRow = { id: "t1", property_id: P, room_id: ROOM, room_code: "101", task_type: "salida", status: "inspeccionada", priority: "normal", work_date: "2026-03-10", assigned_to: null, notes: null, started_at: null, finished_at: null, inspection_result: "aprobada", inspected_by: U, inspected_at: null, inspection_note: null, rejections: 0, created_by: null, created_at: "x", updated_at: "x" };
    const session = new AbortAwareFakeSession([
      { match: /update hoteles\.housekeeping_task/i, respond: () => [{ id: "t1" }] },
      { match: /from hoteles\.housekeeping_task t join hoteles\.room r/i, respond: () => [taskRow] },
      { match: /update hoteles\.room set status = 'disponible'/i, respond: () => pgError("42501", "permission denied") },
    ]);
    await expect(new PostgresHousekeepingRepository(session).inspectTask(P, "t1", { inspectorId: U, approved: true, note: null })).rejects.toBeInstanceOf(HousekeepingAccessDeniedError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});
