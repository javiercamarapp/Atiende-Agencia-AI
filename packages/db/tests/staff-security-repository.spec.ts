// StaffSecurityRepository: (1) la implementacion Postgres traduce una migracion pendiente
// (SQLSTATE 42883/42P01/42703) a `StaffSecurityUnavailableError` FUERA de la transaccion y
// abre UNA transaccion propia por metodo (AbortAwareFakeSession reproduce el estado abortado
// de Postgres; una sesion falsa plana no); (2) la implementacion en memoria tiene la misma
// semantica que la migracion 0025 (lockout, anti-replay, un solo uso, vencimiento).
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import {
  InMemoryCoreRepository,
  InMemoryStaffSecurityRepository,
  PostgresStaffSecurityRepository,
  StaffSecurityUnavailableError,
  TotpAlreadyEnrolledError,
  TotpNoPendingEnrollmentError,
  TotpNotEnrolledError,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { FakeSessionHandler } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Motor falso: cada withAppSession abre una sesion NUEVA y registra los claims. */
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

describe("PostgresStaffSecurityRepository", () => {
  it.each([
    ["42883", "function core.totp_get_status(uuid) does not exist"],
    ["42P01", 'relation "core.staff_totp" does not exist'],
    ["42703", 'column "sessions_revoked_at" does not exist'],
  ])("migracion pendiente (%s) -> StaffSecurityUnavailableError, y la siguiente llamada usa una sesion NUEVA sana", async (code, message) => {
    const { engine, sessions } = fakeEngine((n) =>
      n === 0
        ? [{ match: /totp_get_status/, respond: () => pgError(code, message) }]
        : [{ match: /totp_get_status/, respond: () => [{ enrolled: true, pending: false, locked_until: null, backup_codes_remaining: 8 }] }],
    );
    const repo = new PostgresStaffSecurityRepository(engine);
    await expect(repo.getTotpStatus("u1")).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
    // La sesion 0 quedo abortada, pero NO se reutiliza: la llamada siguiente abre otra.
    await expect(repo.getTotpStatus("u1")).resolves.toMatchObject({ enrolled: true, backupCodesRemaining: 8 });
    expect(sessions).toHaveLength(2);
  });

  it("cada metodo abre su propia transaccion: el fallo se cuenta aunque la ruta falle despues (claims por usuario / sistema)", async () => {
    const { engine, claims } = fakeEngine(() => [
      { match: /totp_register_failure/, respond: () => [{ locked: null }] },
      { match: /create_password_reset_token/, respond: () => [] },
      { match: /consume_password_reset_token/, respond: () => [{ id: null }] },
    ]);
    const repo = new PostgresStaffSecurityRepository(engine);
    await repo.registerTotpFailure("u1");
    await repo.registerTotpFailure("u1");
    await repo.createPasswordResetToken({ staffId: "u1", tokenHash: "h", expiresAt: new Date().toISOString() });
    await expect(repo.consumePasswordResetToken("h", "scrypt$x")).resolves.toBeNull();
    expect(claims).toEqual([{ userId: "u1" }, { userId: "u1" }, { userId: null }, { userId: null }]);
  });

  it("P0001 se traduce a errores de dominio; otros errores se propagan tal cual", async () => {
    const { engine } = fakeEngine(() => [
      { match: /totp_begin_enrollment/, respond: () => pgError("P0001", "ya hay un segundo factor activo") },
      { match: /totp_confirm_enrollment/, respond: () => pgError("P0001", "no hay un alta pendiente") },
      { match: /totp_replace_backup_codes/, respond: () => pgError("P0001", "no hay segundo factor activo") },
      { match: /totp_disable/, respond: () => pgError("42501", "solo la propia cuenta") },
    ]);
    const repo = new PostgresStaffSecurityRepository(engine);
    await expect(repo.beginTotpEnrollment("u1", "c")).rejects.toBeInstanceOf(TotpAlreadyEnrolledError);
    await expect(repo.confirmTotpEnrollment("u1", 1, ["h"])).rejects.toBeInstanceOf(TotpNoPendingEnrollmentError);
    await expect(repo.replaceBackupCodes("u1", ["h"])).rejects.toBeInstanceOf(TotpNotEnrolledError);
    await expect(repo.disableTotp("u1")).rejects.toMatchObject({ code: "42501" });
  });

  it("mapea filas: ISO para fechas, numero para el ultimo paso", async () => {
    const { engine } = fakeEngine(() => [
      { match: /totp_get_secret/, respond: () => [{ secret_ciphertext: "cif", confirmed: true, last_used_step: "58123456", locked_until: new Date("2026-01-01T00:00:00Z") }] },
    ]);
    const row = await new PostgresStaffSecurityRepository(engine).getTotpSecret("u1");
    expect(row).toEqual({ secretCiphertext: "cif", confirmed: true, lastUsedStep: 58123456, lockedUntil: "2026-01-01T00:00:00.000Z" });
  });
});

describe("InMemoryStaffSecurityRepository (misma semantica que la migracion 0025)", () => {
  function setup() {
    const core = new InMemoryCoreRepository();
    core.addStaff({ id: "u1", email: "u1@x.mx", fullName: "U1", passwordHash: "scrypt$old", createdVia: "seed", emailVerifiedAt: null });
    const repo = new InMemoryStaffSecurityRepository(core);
    let now = 1_700_000_000_000;
    repo.now = () => now;
    return { core, repo, advance: (ms: number) => (now += ms) };
  }

  it("alta -> confirmar -> activo con respaldos; no se puede iniciar otra alta con 2FA activo", async () => {
    const { repo } = setup();
    await repo.beginTotpEnrollment("u1", "cif");
    expect(await repo.getTotpStatus("u1")).toMatchObject({ enrolled: false, pending: true });
    await repo.confirmTotpEnrollment("u1", 10, ["a", "b", "c"]);
    expect(await repo.getTotpStatus("u1")).toMatchObject({ enrolled: true, pending: false, backupCodesRemaining: 3 });
    await expect(repo.beginTotpEnrollment("u1", "otro")).rejects.toBeInstanceOf(TotpAlreadyEnrolledError);
    await expect(repo.confirmTotpEnrollment("u1", 11, ["x"])).rejects.toBeInstanceOf(TotpNoPendingEnrollmentError);
  });

  it("anti-replay: solo acepta un paso estrictamente mayor al ultimo", async () => {
    const { repo } = setup();
    await repo.beginTotpEnrollment("u1", "cif");
    await repo.confirmTotpEnrollment("u1", 10, ["a"]);
    expect(await repo.registerTotpSuccess("u1", 10)).toBe(false);
    expect(await repo.registerTotpSuccess("u1", 9)).toBe(false);
    expect(await repo.registerTotpSuccess("u1", 11)).toBe(true);
  });

  it("lockout: 5 fallos bloquean 15 min, bloqueado no acepta nada, despues se libera", async () => {
    const { repo, advance } = setup();
    await repo.beginTotpEnrollment("u1", "cif");
    await repo.confirmTotpEnrollment("u1", 10, ["a"]);
    for (let i = 0; i < 4; i += 1) expect(await repo.registerTotpFailure("u1")).toBeNull();
    const locked = await repo.registerTotpFailure("u1");
    expect(locked).not.toBeNull();
    expect(await repo.registerTotpSuccess("u1", 99)).toBe(false);
    expect(await repo.consumeBackupCode("u1", "a")).toBe(false);
    expect((await repo.getTotpSecret("u1"))?.lockedUntil).toBe(locked);
    advance(15 * 60_000 + 1);
    expect(await repo.registerTotpSuccess("u1", 99)).toBe(true);
  });

  it("codigos de respaldo: un solo uso, regenerar invalida los anteriores", async () => {
    const { repo } = setup();
    await repo.beginTotpEnrollment("u1", "cif");
    await repo.confirmTotpEnrollment("u1", 10, ["a", "b"]);
    expect(await repo.consumeBackupCode("u1", "a")).toBe(true);
    expect(await repo.consumeBackupCode("u1", "a")).toBe(false);
    expect(await repo.consumeBackupCode("u1", "nope")).toBe(false);
    await repo.replaceBackupCodes("u1", ["n"]);
    expect(await repo.consumeBackupCode("u1", "b")).toBe(false);
    expect(await repo.consumeBackupCode("u1", "n")).toBe(true);
    await repo.disableTotp("u1");
    expect(await repo.getTotpStatus("u1")).toMatchObject({ enrolled: false, pending: false, backupCodesRemaining: 0 });
    await expect(repo.replaceBackupCodes("u1", ["z"])).rejects.toBeInstanceOf(TotpNotEnrolledError);
  });

  it("reset de contrasena: un solo uso, vencimiento, un enlace nuevo invalida el anterior; cambia hash, corta sesiones y verifica correo", async () => {
    const { core, repo, advance } = setup();
    const exp = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
    await repo.createPasswordResetToken({ staffId: "u1", tokenHash: "t1", expiresAt: exp(3_600_000) });
    await repo.createPasswordResetToken({ staffId: "u1", tokenHash: "t2", expiresAt: exp(3_600_000) });
    expect(await repo.consumePasswordResetToken("t1", "scrypt$n1")).toBeNull();
    expect(await repo.consumePasswordResetToken("t2", "scrypt$n2")).toBe("u1");
    expect(await repo.consumePasswordResetToken("t2", "scrypt$n3")).toBeNull();
    const staff = await core.findStaffById("u1");
    expect(staff?.passwordHash).toBe("scrypt$n2");
    expect(staff?.emailVerifiedAt).not.toBeNull();
    expect(staff?.sessionsRevokedAt).not.toBeNull();
    await repo.createPasswordResetToken({ staffId: "u1", tokenHash: "t3", expiresAt: exp(1000) });
    advance(2000);
    expect(await repo.consumePasswordResetToken("t3", "scrypt$n4")).toBeNull();
  });

  it("verificacion de correo: un solo uso y vencimiento", async () => {
    const { core, repo, advance } = setup();
    await repo.createEmailVerificationToken({ staffId: "u1", tokenHash: "v1", expiresAt: new Date(1_700_000_000_000 + 1000).toISOString() });
    expect(await repo.consumeEmailVerificationToken("v1")).toBe("u1");
    expect((await core.findStaffById("u1"))?.emailVerifiedAt).not.toBeNull();
    expect(await repo.consumeEmailVerificationToken("v1")).toBeNull();
    await repo.createEmailVerificationToken({ staffId: "u1", tokenHash: "v2", expiresAt: new Date(1_700_000_000_000 + 1000).toISOString() });
    advance(2000);
    expect(await repo.consumeEmailVerificationToken("v2")).toBeNull();
  });

  it("available=false simula la base sin migrar en todos los metodos", async () => {
    const { repo } = setup();
    repo.available = false;
    await expect(repo.getTotpStatus("u1")).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
    await expect(repo.consumePasswordResetToken("t", "scrypt$x")).rejects.toBeInstanceOf(StaffSecurityUnavailableError);
  });
});
