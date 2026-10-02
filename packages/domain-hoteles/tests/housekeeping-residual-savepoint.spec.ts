// H-26/H-29 -- REGLA DURA de compatibilidad con la base sin migrar (039) contra los repositorios Postgres REALES +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion: tras un error toda consulta lanza 25P02 salvo
// ROLLBACK TO SAVEPOINT). Cada prueba FALLA si se quita el SAVEPOINT: la consulta de respaldo o la siguiente del request
// lanzaria 25P02. Una sesion falsa plana NO sirve.
import { describe, expect, it } from "vitest";
import {
  HousekeepingAccessDeniedError,
  HousekeepingConflictError,
  HousekeepingNotFoundError,
  HousekeepingUnavailableError,
  MensajeriaConflictError,
  MensajeriaUnavailableError,
  PostgresHousekeepingResidualRepository,
  PostgresMensajeriaConfigRepository,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const O = "00000000-0000-0000-0000-0000000000a0";
const ROOM = "00000000-0000-0000-0000-0000000000b1";
const TASK = "00000000-0000-0000-0000-0000000000c1";
const U = "00000000-0000-0000-0000-0000000000d1";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const noTable = (t: string) => () => pgError("42P01", `relation "hoteles.${t}" does not exist`);
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

async function sessionStillUsable(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("housekeeping residual: lecturas con la base sin 039 (42P01)", () => {
  it("config, fotos, blancos y opt-out degradan a vacio honesto y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.housekeeping_config/i, respond: noTable("housekeeping_config") },
      { match: /from hoteles\.housekeeping_task_photo/i, respond: noTable("housekeeping_task_photo") },
      { match: /from hoteles\.linen_count/i, respond: noTable("linen_count") },
      { match: /from hoteles\.cleaning_opt_out/i, respond: noTable("cleaning_opt_out") },
      after,
    ]);
    const repo = new PostgresHousekeepingResidualRepository(session);
    const cfg = await repo.getConfig(P);
    expect(cfg.disponible).toBe(false);
    expect(cfg.config).toMatchObject({ autoAssignEnabled: false, photosRequiredOnInspection: false, maxPhotosPerTask: 6, personalizada: false });
    expect(await repo.listPhotos(P, TASK)).toEqual({ disponible: false, photos: [] });
    expect(await repo.countPhotos(P, TASK)).toBe(0);
    expect(await repo.getPhoto(P, TASK, ROOM)).toBeNull();
    expect(await repo.listLinen(P, "2026-03-10")).toEqual({ disponible: false, current: [], previous: [] });
    expect(await repo.listOptOuts(P, "2026-03-10")).toEqual({ disponible: false, optOuts: [] });
    expect(await repo.hasActiveOptOut(P, ROOM, "2026-03-10")).toBe(false);
    await sessionStillUsable(session);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.housekeeping_config/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresHousekeepingResidualRepository(session).getConfig(P)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("housekeeping residual: escrituras -> errores de dominio, con la sesion recuperada", () => {
  it("saveConfig sin 039 -> HousekeepingUnavailableError (503) y la sesion sigue", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.housekeeping_config/i, respond: noTable("housekeeping_config") }, after]);
    await expect(new PostgresHousekeepingResidualRepository(session).saveConfig(P, { autoAssignEnabled: true }, U)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await sessionStillUsable(session);
  });

  it("addPhoto: sin tabla -> 503; tope/tarea cancelada (23514) -> conflicto; FK (23503) -> no encontrada; permiso (42501) -> acceso denegado", async () => {
    const input = { propertyId: P, taskId: TASK, contentType: "image/png" as const, bytes: PNG, caption: null, takenBy: U };
    const cases: [string, unknown][] = [
      ["42P01", HousekeepingUnavailableError],
      ["23514", HousekeepingConflictError],
      ["23503", HousekeepingNotFoundError],
      ["42501", HousekeepingAccessDeniedError],
    ];
    for (const [code, expected] of cases) {
      const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.housekeeping_task_photo/i, respond: () => pgError(code, "x") }, after]);
      await expect(new PostgresHousekeepingResidualRepository(session).addPhoto(input)).rejects.toBeInstanceOf(expected as typeof Error);
      await sessionStillUsable(session);
    }
  });

  it("registerOptOut: duplicado activo (23505) -> conflicto; sin tabla -> 503; la sesion sigue", async () => {
    const input = { propertyId: P, roomId: ROOM, optOutDate: "2026-03-10", source: "recepcion" as const, note: null, createdBy: U };
    const dup = new AbortAwareFakeSession([
      { match: /select id from hoteles\.room/i, respond: () => [{ id: ROOM }] },
      { match: /insert into hoteles\.cleaning_opt_out/i, respond: () => pgError("23505", "dup") },
      after,
    ]);
    await expect(new PostgresHousekeepingResidualRepository(dup).registerOptOut(input)).rejects.toBeInstanceOf(HousekeepingConflictError);
    await sessionStillUsable(dup);
    const missing = new AbortAwareFakeSession([
      { match: /select id from hoteles\.room/i, respond: () => [{ id: ROOM }] },
      { match: /insert into hoteles\.cleaning_opt_out/i, respond: noTable("cleaning_opt_out") },
      after,
    ]);
    await expect(new PostgresHousekeepingResidualRepository(missing).registerOptOut(input)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
    await sessionStillUsable(missing);
  });

  it("registerOptOut con exito cancela tareas pendientes de estancia/repaso en la misma transaccion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select id from hoteles\.room/i, respond: () => [{ id: ROOM }] },
      { match: /insert into hoteles\.cleaning_opt_out/i, respond: () => [{ id: TASK }] },
      { match: /update hoteles\.housekeeping_task set status = 'cancelada'/i, respond: () => [{ id: "t1" }, { id: "t2" }] },
      { match: /from hoteles\.cleaning_opt_out o join hoteles\.room r/i, respond: () => [{ id: TASK, room_id: ROOM, room_code: "101", opt_out_date: "2026-03-10", source: "recepcion", note: null, status: "activo", created_by: U, created_at: "x", reverted_at: null }] },
    ]);
    const r = await new PostgresHousekeepingResidualRepository(session).registerOptOut({ propertyId: P, roomId: ROOM, optOutDate: "2026-03-10", source: "recepcion", note: null, createdBy: U });
    expect(r.tareasCanceladas).toBe(2);
    expect(r.optOut).toMatchObject({ roomCode: "101", status: "activo" });
  });
});

describe("mensajeria (H-29): base sin 039", () => {
  const channelRow = { phone_number_id: "123456", enabled: true, updated_at: null };

  it("getWhatsAppChannel cae a la consulta sin updated_at (42703) y la sesion sigue", async () => {
    let first = true;
    const session = new AbortAwareFakeSession([
      { match: /updated_at::text as updated_at from hoteles\.whatsapp_channel_config/i, respond: () => (first ? ((first = false), pgError("42703", 'column "updated_at" does not exist')) : [channelRow]) },
      { match: /null::text as updated_at from hoteles\.whatsapp_channel_config/i, respond: () => [channelRow] },
      after,
    ]);
    const status = await new PostgresMensajeriaConfigRepository(session).getWhatsAppChannel(P);
    expect(status).toEqual({ configurado: true, phoneNumberId: "123456", enabled: true, updatedAt: null });
    await sessionStillUsable(session);
  });

  it("lecturas sin tablas -> 'no configurado' sin lanzar", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.whatsapp_channel_config/i, respond: noTable("whatsapp_channel_config") },
      { match: /from hoteles\.voice_agent_config/i, respond: noTable("voice_agent_config") },
      after,
    ]);
    const repo = new PostgresMensajeriaConfigRepository(session);
    expect(await repo.getWhatsAppChannel(P)).toMatchObject({ configurado: false, phoneNumberId: null });
    expect(await repo.getVoiceAgent(P)).toMatchObject({ configurado: false, secretoConfigurado: false });
    await sessionStillUsable(session);
  });

  it("escrituras: 42501 (sin GRANT de 039) y 42703 -> no disponible; 23505 -> conflicto de numero", async () => {
    for (const code of ["42501", "42703", "42P01"]) {
      const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.whatsapp_channel_config/i, respond: () => pgError(code, "x") }, after]);
      await expect(new PostgresMensajeriaConfigRepository(session).saveWhatsAppChannel(P, { phoneNumberId: "123456", enabled: true }, U)).rejects.toBeInstanceOf(MensajeriaUnavailableError);
      await sessionStillUsable(session);
    }
    const dup = new AbortAwareFakeSession([{ match: /insert into hoteles\.whatsapp_channel_config/i, respond: () => pgError("23505", "dup") }, after]);
    await expect(new PostgresMensajeriaConfigRepository(dup).saveWhatsAppChannel(P, { phoneNumberId: "123456", enabled: true }, U)).rejects.toBeInstanceOf(MensajeriaConflictError);
    await sessionStillUsable(dup);
  });

  it("rotateVoiceSecret usa parametros (no excluded.*) y nunca devuelve el secreto", async () => {
    const seen: string[] = [];
    const session = new AbortAwareFakeSession([
      { match: /insert into hoteles\.voice_agent_config/i, respond: () => [{ enabled: true, updated_at: "x", tiene_secreto: true }] },
    ]);
    const origQuery = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      seen.push(sql);
      return origQuery(sql, params);
    }) as typeof session.query;
    const status = await new PostgresMensajeriaConfigRepository(session).rotateVoiceSecret(P, O, "secreto-de-prueba", true);
    expect(status).toEqual({ configurado: true, enabled: true, secretoConfigurado: true, updatedAt: "x" });
    expect(JSON.stringify(status)).not.toContain("secreto-de-prueba");
    expect(seen[0]).not.toMatch(/excluded\./i);
  });
});
