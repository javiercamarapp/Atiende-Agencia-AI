// H-P3-04 -- REGLA DURA de compatibilidad con la base sin migrar (045) contra los repositorios Postgres REALES + AbortAwareFakeSession
// (reproduce el estado ABORTADO de una transaccion: tras un error toda consulta lanza 25P02 salvo ROLLBACK TO SAVEPOINT). Cada prueba
// FALLA si se quita el SAVEPOINT. Una sesion falsa plana NO sirve.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUSEKEEPING_CONFIG,
  HousekeepingUnavailableError,
  PostgresHousekeepingDiaSistemaRepository,
  PostgresHousekeepingResidualRepository,
  parseHousekeepingConfigPatch,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const U = "00000000-0000-0000-0000-0000000000d1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const noFn = (f: string) => () => pgError("42883", `function hoteles.${f}() does not exist`);
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

async function sessionStillUsable(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("arranque del dia (cron, sesion de sistema) con la base sin la migracion 045", () => {
  it("cada operacion lanza HousekeepingUnavailableError y la sesion sigue utilizable (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_hk_config/i, respond: noFn("system_hk_config") },
      { match: /system_hk_start_day/i, respond: noFn("system_hk_start_day") },
      { match: /system_hk_list_day_tasks/i, respond: noFn("system_hk_list_day_tasks") },
      { match: /system_hk_list_camaristas/i, respond: noFn("system_hk_list_camaristas") },
      { match: /system_hk_assign_task/i, respond: noFn("system_hk_assign_task") },
      { match: /system_hk_finish_day/i, respond: noFn("system_hk_finish_day") },
      after,
    ]);
    const repo = new PostgresHousekeepingDiaSistemaRepository(session);
    await expect(repo.config(P)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await sessionStillUsable(session);
    await expect(repo.startDay(P, "2026-01-15")).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await expect(repo.listDayTasks(P, "2026-01-15")).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await expect(repo.listCamaristas(P)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await expect(repo.assignTask(P, P, U)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await expect(repo.finishDay(P, "2026-01-15", 1, 0)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await sessionStillUsable(session);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_hk_start_day/i, respond: () => pgError("42501", "system_hk_start_day es solo para la sesion de sistema") }]);
    await expect(new PostgresHousekeepingDiaSistemaRepository(session).startDay(P, "2026-01-15")).rejects.toMatchObject({ code: "42501" });
  });

  it("config sin fila propia devuelve los defaults (asignacion apagada, arranque 07:00); con fila, los valores guardados", async () => {
    const vacia = new AbortAwareFakeSession([{ match: /system_hk_config/i, respond: () => [] }]);
    expect(await new PostgresHousekeepingDiaSistemaRepository(vacia).config(P)).toEqual(DEFAULT_HOUSEKEEPING_CONFIG);
    const propia = new AbortAwareFakeSession([
      {
        match: /system_hk_config/i,
        respond: () => [{ out_auto_assign_enabled: true, out_max_tasks_per_camarista: 10, out_shift_minutes: 400, out_minutes_salida: 30, out_minutes_estancia: 15, out_minutes_profunda: 80, out_minutes_repaso: 8, out_start_hour: 6 }],
      },
    ]);
    expect(await new PostgresHousekeepingDiaSistemaRepository(propia).config(P)).toMatchObject({ autoAssignEnabled: true, maxTasksPerCamarista: 10, shiftMinutes: 400, startHour: 6, minutesByType: { salida: 30, repaso: 8 } });
  });

  it("startDay mapea el ledger: reclamado/no reclamado con el conteo generado", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /system_hk_start_day/i, respond: () => [{ out_claimed: true, out_generated: 12 }] }]);
    expect(await new PostgresHousekeepingDiaSistemaRepository(s1).startDay(P, "2026-01-15")).toEqual({ reclamado: true, generadas: 12 });
    const s2 = new AbortAwareFakeSession([{ match: /system_hk_start_day/i, respond: () => [{ out_claimed: false, out_generated: 0 }] }]);
    expect(await new PostgresHousekeepingDiaSistemaRepository(s2).startDay(P, "2026-01-15")).toEqual({ reclamado: false, generadas: 0 });
  });
});

describe("hora de arranque en la configuracion editable (H-P3-04) con la base con 039 pero sin 045", () => {
  const configRow = {
    property_id: P, auto_assign_enabled: false, max_tasks_per_camarista: 14, shift_minutes: 480, minutes_salida: 40, minutes_estancia: 20,
    minutes_profunda: 90, minutes_repaso: 10, photos_required_on_inspection: false, max_photos_per_task: 6, updated_at: "2026-01-01 00:00:00+00",
  };

  it("GET: la configuracion de siempre sigue disponible; la hora usa el default 7 y se marca no disponible (42703), sesion sana", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select start_hour from hoteles\.housekeeping_config/i, respond: () => pgError("42703", 'column "start_hour" does not exist') },
      { match: /from hoteles\.housekeeping_config/i, respond: () => [configRow] },
      after,
    ]);
    const r = await new PostgresHousekeepingResidualRepository(session).getConfig(P);
    expect(r.disponible).toBe(true);
    expect(r.config).toMatchObject({ maxTasksPerCamarista: 14, startHour: 7, startHourDisponible: false });
    await sessionStillUsable(session);
  });

  it("GET con la 045: la hora guardada se expone y esta disponible", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select start_hour from hoteles\.housekeeping_config/i, respond: () => [{ start_hour: 9 }] },
      { match: /from hoteles\.housekeeping_config/i, respond: () => [configRow] },
    ]);
    expect((await new PostgresHousekeepingResidualRepository(session).getConfig(P)).config).toMatchObject({ startHour: 9, startHourDisponible: true });
  });

  it("PUT con horaArranque sin 045 -> HousekeepingUnavailableError (503) y la sesion sigue utilizable; sin horaArranque el PUT de siempre funciona", async () => {
    const session = new AbortAwareFakeSession([
      { match: /update hoteles\.housekeeping_config set start_hour/i, respond: () => pgError("42703", 'column "start_hour" does not exist') },
      { match: /insert into hoteles\.housekeeping_config/i, respond: () => [configRow] },
      { match: /from hoteles\.housekeeping_config/i, respond: () => [configRow] },
      after,
    ]);
    const repo = new PostgresHousekeepingResidualRepository(session);
    await expect(repo.saveConfig(P, { startHour: 6 }, U)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await sessionStillUsable(session);
  });
});

describe("parseHousekeepingConfigPatch: horaArranque", () => {
  it("acepta enteros 0..23 y rechaza el resto", () => {
    expect(parseHousekeepingConfigPatch({ horaArranque: 0 })).toEqual({ startHour: 0 });
    expect(parseHousekeepingConfigPatch({ horaArranque: 23 })).toEqual({ startHour: 23 });
    for (const malo of [24, -1, 7.5, "7", null]) expect(() => parseHousekeepingConfigPatch({ horaArranque: malo })).toThrow();
  });
});
