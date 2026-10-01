// L-22 -- repositorio de dias inhabiles: en memoria (aislamiento, unicidad, soft delete) y Postgres
// contra la base SIN migrar con AbortAwareFakeSession (una sesion plana no reproduce 25P02).
import { describe, expect, it } from "vitest";
import { DiaInhabilDuplicateError, DiaInhabilNotAvailableError, officialOnlyCalendar } from "../src/dias-inhabiles.ts";
import type { DiaInhabilCreateInput } from "../src/dias-inhabiles.ts";
import { InMemoryDiasInhabilesRepository, PostgresDiasInhabilesRepository } from "../src/dias-inhabiles-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";
const USER = "00000000-0000-0000-0000-0000000000c1";
const TENDER = "00000000-0000-0000-0000-0000000000d1";

function input(fecha: string, extra: Partial<DiaInhabilCreateInput> = {}): DiaInhabilCreateInput {
  return { fecha, nombre: "Dia declarado", tenderId: null, publicadoPor: null, fuente: null, verificacion: "por_validar", ...extra };
}

function pgError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("InMemoryDiasInhabilesRepository", () => {
  it("aisla por organizacion y combina organizacion + convocatoria en el calendario", async () => {
    const repo = new InMemoryDiasInhabilesRepository();
    await repo.create(ORG_A, USER, input("2026-04-02"));
    await repo.create(ORG_A, USER, input("2026-04-10", { tenderId: TENDER }));
    await repo.create(ORG_B, USER, input("2026-04-20"));
    expect((await repo.list(ORG_A)).map((d) => d.fecha)).toEqual(["2026-04-02", "2026-04-10"]);
    expect((await repo.list(ORG_B)).map((d) => d.fecha)).toEqual(["2026-04-20"]);
    const conTender = await repo.resolveCalendario(ORG_A, { tenderId: TENDER });
    expect(conTender.holidays).toContain("2026-04-10");
    expect(conTender.holidays).toContain("2026-04-02");
    expect(conTender.holidays).not.toContain("2026-04-20");
    const sinTender = await repo.resolveCalendario(ORG_A);
    expect(sinTender.holidays).not.toContain("2026-04-10");
  });

  it("rechaza el duplicado vigente, permite repetir tras quitar y no quita dias de otra organizacion", async () => {
    const repo = new InMemoryDiasInhabilesRepository();
    const dia = await repo.create(ORG_A, USER, input("2026-04-02"));
    await expect(repo.create(ORG_A, USER, input("2026-04-02"))).rejects.toBeInstanceOf(DiaInhabilDuplicateError);
    // misma fecha pero otro alcance (convocatoria) no choca
    await expect(repo.create(ORG_A, USER, input("2026-04-02", { tenderId: TENDER }))).resolves.toBeTruthy();
    expect(await repo.remove(ORG_B, dia.id)).toBe(false);
    expect(await repo.remove(ORG_A, dia.id)).toBe(true);
    expect(await repo.remove(ORG_A, dia.id)).toBe(false);
    await expect(repo.create(ORG_A, USER, input("2026-04-02"))).resolves.toBeTruthy();
  });
});

describe("PostgresDiasInhabilesRepository -- base SIN migrar (SAVEPOINT)", () => {
  it("resolveCalendario: 42P01 (tabla inexistente) cae al calendario oficial y la sesion queda RECUPERADA, no 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /dia_inhabil/, respond: () => pgError("42P01", 'relation "licitaciones.dia_inhabil" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const cal = await new PostgresDiasInhabilesRepository(session).resolveCalendario(ORG_A, { tenderId: TENDER });
    expect(cal.holidays).toEqual(officialOnlyCalendar().holidays);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // la transaccion compartida NO quedo abortada: la siguiente consulta del request funciona
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("resolveCalendario de sistema: 42883 (funcion inexistente) tambien cae a los oficiales", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_list_dias_inhabiles/, respond: () => pgError("42883", "function licitaciones.system_list_dias_inhabiles(uuid) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const cal = await new PostgresDiasInhabilesRepository(session).resolveCalendario(ORG_A, { sistema: true });
    expect(cal.holidays).toEqual(officialOnlyCalendar().holidays);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("list / create / remove: 42P01 -> DiaInhabilNotAvailableError con la sesion usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /dia_inhabil/, respond: () => pgError("42P01", 'relation "licitaciones.dia_inhabil" does not exist') },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresDiasInhabilesRepository(session);
    await expect(repo.list(ORG_A)).rejects.toBeInstanceOf(DiaInhabilNotAvailableError);
    await expect(repo.create(ORG_A, USER, input("2026-04-02"))).rejects.toBeInstanceOf(DiaInhabilNotAvailableError);
    await expect(repo.remove(ORG_A, TENDER)).rejects.toBeInstanceOf(DiaInhabilNotAvailableError);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error de operador (42883 'operator does not exist') NO se disfraza de migracion pendiente", async () => {
    const session = new AbortAwareFakeSession([{ match: /dia_inhabil/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresDiasInhabilesRepository(session).list(ORG_A)).rejects.toThrow(/operator does not exist/);
  });

  it("23505 -> DiaInhabilDuplicateError", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into licitaciones\.dia_inhabil/, respond: () => pgError("23505", "duplicate key value") }]);
    await expect(new PostgresDiasInhabilesRepository(session).create(ORG_A, USER, input("2026-04-02"))).rejects.toBeInstanceOf(DiaInhabilDuplicateError);
  });

  it("base migrada: mapea filas y construye el calendario con los dias declarados", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from licitaciones\.dia_inhabil/,
        respond: () => [
          { id: "1", tender_id: null, fecha: "2026-04-02", nombre: "Jueves Santo", publicado_por: "SHCP", fuente: null, verificacion: "por_validar", created_by: USER, created_at: "2026-01-01T00:00:00Z" },
          { id: "2", tender_id: TENDER, fecha: "2026-04-10", nombre: "Dia convocante", publicado_por: null, fuente: null, verificacion: "verificada", created_by: USER, created_at: "2026-01-01T00:00:00Z" },
        ],
      },
    ]);
    const cal = await new PostgresDiasInhabilesRepository(session).resolveCalendario(ORG_A, { tenderId: TENDER });
    expect(cal.holidays).toContain("2026-04-02");
    expect(cal.holidays).toContain("2026-04-10");
    expect(cal.entries.filter((e) => e.alcance === "convocatoria")).toHaveLength(1);
  });
});

describe("recordatorios de plazo con dias habiles (barrido de sistema)", () => {
  const TENDER_ROW = { out_id: TENDER, out_title: "Suministro", out_submission_deadline: "2026-03-16T20:00:00+00:00" };

  it("base SIN migrar: el barrido sigue creando el recordatorio (no 25P02) con dias habiles de los oficiales y avisa del feriado", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_list_tenders_with_upcoming_deadline/, respond: () => [TENDER_ROW] },
      { match: /system_list_dias_inhabiles/, respond: () => pgError("42883", "function licitaciones.system_list_dias_inhabiles(uuid) does not exist") },
      { match: /system_record_deadline_reminder/, respond: () => [{ out_id: "r1", out_created_at: "2026-03-10T00:00:00Z" }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    const result = await repo.scanUpcomingDeadlineReminders(ORG_A, { nowIso: "2026-03-13T15:00:00Z", windowDays: 5 });
    expect(result.created).toBe(1);
    // 16-mar-2026 es el natalicio de Benito Juarez (feriado oficial): el plazo cae en inhabil y no es 'hoy' aunque queden 0 habiles
    expect(result.reminders[0]!.message).toMatch(/cae en un día inhábil \(Natalicio de Benito Juárez/);
    expect(result.reminders[0]!.message).not.toMatch(/Vence hoy/);
  });

  it("con dias declarados por la organizacion los usa (lectura de sistema)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_list_tenders_with_upcoming_deadline/, respond: () => [{ ...TENDER_ROW, out_submission_deadline: "2026-03-18T20:00:00+00:00" }] },
      { match: /system_list_dias_inhabiles/, respond: () => [{ out_fecha: "2026-03-17", out_tender_id: null, out_nombre: "Dia declarado", out_publicado_por: null, out_fuente: null, out_verificacion: "por_validar" }] },
      { match: /system_record_deadline_reminder/, respond: () => [{ out_id: "r1", out_created_at: "2026-03-10T00:00:00Z" }] },
    ]);
    const result = await new PostgresLicitacionesRepository(session).scanUpcomingDeadlineReminders(ORG_A, { nowIso: "2026-03-13T15:00:00Z", windowDays: 7 });
    // vie 13 -> mie 18: lun 16 (feriado), mar 17 (declarado) fuera -> solo el miercoles 18 = 1 habil
    expect(result.reminders[0]!.message).toMatch(/Quedan 1 día\(s\) hábil\(es\)\./);
  });
});
