// Sesiones activas del staff y vinculos de Google (migracion 0033): (1) la implementacion Postgres
// abre una transaccion propia por metodo, usa el rol correcto (sistema para registrar, el propio
// usuario para listar/cerrar) y traduce una migracion pendiente a `StaffSecurityUnavailableError`
// sin dejar abortada la sesion de la siguiente llamada (AbortAwareFakeSession reproduce el estado
// abortado de Postgres); (2) la implementacion en memoria tiene la misma semantica que la SQL.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryCoreRepository, InMemoryStaffSecurityRepository, PostgresStaffSecurityRepository, StaffSecurityUnavailableError } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function fakeEngine(handlersFor: (n: number) => readonly FakeSessionHandler[]) {
  const sessions: AbortAwareFakeSession[] = [];
  const claims: Array<{ userId: string | null }> = [];
  const engine: TenancyEngine = {
    async withAppSession<T>(c: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>): Promise<T> {
      claims.push(c);
      const session = new AbortAwareFakeSession(handlersFor(sessions.length));
      sessions.push(session);
      return fn(session);
    },
  };
  return { engine, sessions, claims };
}

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

describe("PostgresStaffSecurityRepository: sesiones y Google", () => {
  it("registrar corre como sistema (userId null); listar/cerrar/identidades como el propio usuario", async () => {
    const { engine, claims } = fakeEngine(() => [
      { match: /register_staff_session/, respond: () => [] },
      { match: /list_staff_sessions/, respond: () => [{ id: "s1", started_at: new Date("2026-01-01T00:00:00Z"), issued_at: "2026-01-02T00:00:00Z", expires_at: new Date("2026-02-01T00:00:00Z"), user_agent: "UA" }] },
      { match: /revoke_staff_session/, respond: () => [{ ok: true }] },
      { match: /revoke_all_staff_sessions/, respond: () => [] },
      { match: /list_google_identities/, respond: () => [{ id: "g1", email: "a@gmail.com", created_at: new Date("2026-01-03T00:00:00Z") }] },
      { match: /unlink_google_identity/, respond: () => [{ ok: false }] },
    ]);
    const repo = new PostgresStaffSecurityRepository(engine);
    await repo.registerSession({ staffId: "u1", jti: "j1", expiresAt: FUTURE(), userAgent: null });
    expect(await repo.listSessions("u1")).toEqual([
      { id: "s1", startedAt: "2026-01-01T00:00:00.000Z", issuedAt: "2026-01-02T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z", userAgent: "UA" },
    ]);
    expect(await repo.revokeSession("u1", "s1")).toBe(true);
    await repo.revokeAllSessions("u1");
    expect(await repo.listGoogleIdentities("u1")).toEqual([{ id: "g1", email: "a@gmail.com", linkedAt: "2026-01-03T00:00:00.000Z" }]);
    expect(await repo.unlinkGoogleIdentity("u1", "g9")).toBe(false);
    expect(claims).toEqual([{ userId: null }, { userId: "u1" }, { userId: "u1" }, { userId: "u1" }, { userId: "u1" }, { userId: "u1" }]);
  });

  it.each([
    ["42883", "function core.register_staff_session(uuid, uuid, timestamp with time zone, text, uuid) does not exist"],
    ["42P01", 'relation "core.staff_session" does not exist'],
  ])("migracion pendiente (%s) -> StaffSecurityUnavailableError; la siguiente llamada usa una sesion NUEVA sana", async (code, message) => {
    const { engine, sessions } = fakeEngine((n) =>
      n === 0 ? [{ match: /register_staff_session/, respond: () => pgError(code, message) }] : [{ match: /list_staff_sessions/, respond: () => [] }],
    );
    const repo = new PostgresStaffSecurityRepository(engine);
    await expect(repo.registerSession({ staffId: "u1", jti: "j1", expiresAt: FUTURE(), userAgent: "ua" })).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
    await expect(repo.listSessions("u1")).resolves.toEqual([]);
    expect(sessions).toHaveLength(2);
  });

  it("un error que NO es migracion pendiente (42501) se propaga tal cual", async () => {
    const { engine } = fakeEngine(() => [{ match: /list_staff_sessions/, respond: () => pgError("42501", "solo la propia cuenta") }]);
    await expect(new PostgresStaffSecurityRepository(engine).listSessions("u1")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("InMemoryStaffSecurityRepository: sesiones (misma semantica que la migracion 0033)", () => {
  function setup() {
    const core = new InMemoryCoreRepository();
    for (const id of ["u1", "u2"]) core.addStaff({ id, email: `${id}@x.mx`, fullName: id, passwordHash: "scrypt$old", createdVia: "seed", emailVerifiedAt: null });
    return { core, repo: new InMemoryStaffSecurityRepository(core) };
  }

  it("registrar -> listar; el UA se recorta a 200 caracteres", async () => {
    const { repo } = setup();
    await repo.registerSession({ staffId: "u1", jti: "j1", expiresAt: FUTURE(), userAgent: "x".repeat(500) });
    const [s] = await repo.listSessions("u1");
    expect(s?.id).toBe("j1");
    expect(s?.userAgent).toHaveLength(200);
    expect(await repo.listSessions("u2")).toEqual([]);
  });

  it("rotacion: reemplaza la fila vieja y hereda started_at; una rotacion con el jti de OTRA cuenta no la toca", async () => {
    const { repo } = setup();
    let t = 1_000_000_000_000;
    repo.now = () => t;
    await repo.registerSession({ staffId: "u1", jti: "j1", expiresAt: new Date(t + 86_400_000).toISOString(), userAgent: "a" });
    t += 60_000;
    await repo.registerSession({ staffId: "u1", jti: "j2", expiresAt: new Date(t + 86_400_000).toISOString(), userAgent: "a", replacesJti: "j1" });
    const sessions = await repo.listSessions("u1");
    expect(sessions.map((s) => s.id)).toEqual(["j2"]);
    expect(sessions[0]?.startedAt).toBe(new Date(1_000_000_000_000).toISOString());
    // u2 intenta "reemplazar" la sesion de u1: la de u1 sigue viva.
    await repo.registerSession({ staffId: "u2", jti: "k1", expiresAt: new Date(t + 86_400_000).toISOString(), userAgent: null, replacesJti: "j2" });
    expect((await repo.listSessions("u1")).map((s) => s.id)).toEqual(["j2"]);
  });

  it("cerrar: solo la propia (ajena -> false), revoca el refresh token y desaparece de la lista", async () => {
    const { repo, core } = setup();
    await repo.registerSession({ staffId: "u1", jti: "j1", expiresAt: FUTURE(), userAgent: null });
    expect(await repo.revokeSession("u2", "j1")).toBe(false);
    expect(await core.isRefreshTokenRevoked("j1")).toBe(false);
    expect((await repo.listSessions("u1")).length).toBe(1);
    expect(await repo.revokeSession("u1", "j1")).toBe(true);
    expect(await core.isRefreshTokenRevoked("j1")).toBe(true);
    expect(await repo.listSessions("u1")).toEqual([]);
    expect(await repo.revokeSession("u1", "j1")).toBe(false);
  });

  it("no lista vencidas, revocadas por logout ni anteriores al corte masivo", async () => {
    const { repo, core } = setup();
    await repo.registerSession({ staffId: "u1", jti: "vencida", expiresAt: new Date(Date.now() - 1000).toISOString(), userAgent: null });
    await repo.registerSession({ staffId: "u1", jti: "logout", expiresAt: FUTURE(), userAgent: null });
    await core.revokeRefreshToken({ jti: "logout", userId: "u1", expiresAt: FUTURE() });
    expect(await repo.listSessions("u1")).toEqual([]);
    await repo.registerSession({ staffId: "u1", jti: "viva", expiresAt: FUTURE(), userAgent: null });
    expect((await repo.listSessions("u1")).map((s) => s.id)).toEqual(["viva"]);
    // corte masivo posterior a la emision de "viva"
    await new Promise((r) => setTimeout(r, 5));
    await core.revokeAllRefreshTokens("u1");
    expect(await repo.listSessions("u1")).toEqual([]);
  });

  it("cerrar todas: corta las previas (truncado a segundo) y una sesion emitida despues del corte sigue viva", async () => {
    const { repo, core } = setup();
    const t0 = Date.now();
    await repo.registerSession({ staffId: "u1", jti: "previa", expiresAt: FUTURE(), userAgent: null });
    repo.now = () => t0 + 2000; // emitida 2 s despues: posterior al corte truncado de "ahora"
    await repo.revokeAllSessions("u1");
    // corte = floor(ahora real); la previa se emitio en un segundo anterior simulado:
    const row = (await core.findStaffById("u1"))?.sessionsRevokedAt;
    expect(row && new Date(row).getMilliseconds()).toBe(0);
    await repo.registerSession({ staffId: "u1", jti: "nueva", expiresAt: FUTURE(), userAgent: null });
    expect((await repo.listSessions("u1")).map((s) => s.id)).toContain("nueva");
  });

  it("tope de 50 sesiones vivas por cuenta (descarta las mas viejas)", async () => {
    const { repo } = setup();
    let t = Date.now();
    repo.now = () => t;
    for (let i = 0; i < 52; i += 1) {
      t += 1000;
      await repo.registerSession({ staffId: "u1", jti: `j${i}`, expiresAt: new Date(t + 86_400_000).toISOString(), userAgent: null });
    }
    const ids = (await repo.listSessions("u1")).map((s) => s.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("j0");
    expect(ids).toContain("j51");
  });

  it("base sin migrar: todo lanza StaffSecurityUnavailableError", async () => {
    const { repo } = setup();
    repo.available = false;
    await expect(repo.listSessions("u1")).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
    await expect(repo.registerSession({ staffId: "u1", jti: "j", expiresAt: FUTURE(), userAgent: null })).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
  });
});

describe("InMemoryStaffSecurityRepository: identidades de Google", () => {
  it("lista las propias (sin sub), desvincular ajena -> false, propia -> true y libera el sub", async () => {
    const core = new InMemoryCoreRepository();
    for (const id of ["u1", "u2"]) core.addStaff({ id, email: `${id}@x.mx`, fullName: id, passwordHash: "scrypt$old", createdVia: "seed", emailVerifiedAt: null });
    const repo = new InMemoryStaffSecurityRepository(core);
    await core.linkGoogleIdentity({ staffId: "u1", sub: "sub-1", email: "u1@gmail.com" });
    const [g] = await repo.listGoogleIdentities("u1");
    expect(g).toMatchObject({ email: "u1@gmail.com" });
    expect(JSON.stringify(g)).not.toContain("sub-1");
    expect(await repo.listGoogleIdentities("u2")).toEqual([]);
    expect(await repo.unlinkGoogleIdentity("u2", g!.id)).toBe(false);
    expect(await repo.listGoogleIdentities("u1")).toHaveLength(1);
    expect(await repo.unlinkGoogleIdentity("u1", g!.id)).toBe(true);
    expect(await core.findStaffByGoogleSub("sub-1")).toBeNull();
  });
});
