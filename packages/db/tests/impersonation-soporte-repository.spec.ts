// Sesión de soporte (0058) sobre el adaptador Postgres: compatibilidad con la base sin migrar con SAVEPOINT real
// (la transacción del request no queda abortada) y camino anterior (impersonación clásica) cuando falta la 0058.
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { ImpersonationReasonInvalidError, PostgresImpersonationRepository } from "../src/impersonation-repository.ts";

const NOW = Date.parse("2030-03-04T10:00:00.000Z");
const sessionRow = (minutes: number) => ({
  id: "s-1",
  actor_user_id: "u-1",
  actor_email: "a@x.mx",
  organization_id: "o-1",
  reason: "motivo suficiente",
  started_at: new Date(NOW).toISOString(),
  expires_at: new Date(NOW + minutes * 60_000).toISOString(),
});

function pgError(code: string, message: string) {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** Postgres simulado: `missing` lista las funciones que "no existen" (42883 aborta la transacción hasta ROLLBACK TO SAVEPOINT). */
class FakePg implements TenantDbSession {
  aborted = false;
  readonly queries: string[] = [];
  constructor(
    private readonly missing: ReadonlySet<string>,
    private readonly responses: Record<string, unknown[] | Error> = {},
  ) {}
  async query<T>(sql: string): Promise<{ rows: T[] }> {
    const name = /core\.(\w+)\(/.exec(sql)?.[1] ?? "?";
    this.queries.push(name);
    if (this.aborted) throw pgError("25P02", "current transaction is aborted");
    if (this.missing.has(name)) {
      this.aborted = true;
      throw pgError("42883", `function core.${name} does not exist`);
    }
    const r = this.responses[name];
    if (r instanceof Error) {
      this.aborted = true;
      throw r;
    }
    return { rows: (r ?? []) as T[] };
  }
  async exec(sql: string): Promise<void> {
    if (/^\s*ROLLBACK TO SAVEPOINT/i.test(sql)) this.aborted = false;
  }
}

describe("PostgresImpersonationRepository -- soporte (0058)", () => {
  it("con la 0058: usa start_support_session y devuelve kind soporte (60 min)", async () => {
    const db = new FakePg(new Set(), { start_support_session: [sessionRow(60)] });
    const r = await new PostgresImpersonationRepository(db).startSupportSession("u-1", "o-1", "motivo suficiente");
    expect(r.kind).toBe("soporte");
    expect(r.session?.expiresAtMs).toBe(NOW + 60 * 60_000);
    expect(db.queries).toEqual(["start_support_session"]);
  });

  it("sin la 0058: cae a la impersonación clásica (15 min) y lo dice; la transacción sigue viva", async () => {
    const db = new FakePg(new Set(["start_support_session"]), { start_impersonation_session: [sessionRow(15)] });
    const r = await new PostgresImpersonationRepository(db).startSupportSession("u-1", "o-1", "motivo de al menos veinte caracteres");
    expect(r.availability).toBe("available");
    expect(r.kind).toBe("clasica");
    expect(r.session?.expiresAtMs).toBe(NOW + 15 * 60_000);
    expect(db.aborted).toBe(false);
  });

  it("sin la 0058 ni la 0020: not_migrated, sin sesión", async () => {
    const db = new FakePg(new Set(["start_support_session", "start_impersonation_session"]));
    const r = await new PostgresImpersonationRepository(db).startSupportSession("u-1", "o-1", "motivo suficiente");
    expect(r).toEqual({ availability: "not_migrated", kind: null, session: null });
    expect(db.aborted).toBe(false);
  });

  it("el rechazo de negocio del motivo corto (22023) se propaga tipado, no cae al camino anterior", async () => {
    const db = new FakePg(new Set(), { start_support_session: pgError("22023", "motivo obligatorio") });
    await expect(new PostgresImpersonationRepository(db).startSupportSession("u-1", "o-1", "corto")).rejects.toBeInstanceOf(ImpersonationReasonInvalidError);
    expect(db.queries).toEqual(["start_support_session"]);
  });

  it("estado: con la 0058 lee get_support_session_state; sin ella usa la sesión clásica activa (nunca elevada ni de soporte)", async () => {
    const con = new FakePg(new Set(), {
      get_support_session_state: [{ organization_id: "o-1", expires_at: new Date(NOW + 60_000).toISOString(), active: true, elevated: true, soporte: true }],
    });
    const a = await new PostgresImpersonationRepository(con).getSupportState("u-1", "s-1");
    expect(a.state).toMatchObject({ organizationId: "o-1", active: true, elevated: true, soporte: true, expiresAtMs: NOW + 60_000 });

    const sin = new FakePg(new Set(["get_support_session_state"]), { get_active_impersonation_session_for_superadmin: [sessionRow(15)] });
    const b = await new PostgresImpersonationRepository(sin).getSupportState("u-1", "s-1");
    expect(b.state).toMatchObject({ organizationId: "o-1", active: true, elevated: false, soporte: false });
    const otra = await new PostgresImpersonationRepository(new FakePg(new Set(["get_support_session_state"]), { get_active_impersonation_session_for_superadmin: [sessionRow(15)] })).getSupportState("u-1", "otra");
    expect(otra.state).toBeNull();
  });

  it("elevar, conceder y revocar degradan a not_migrated sin abortar la transacción", async () => {
    const db = new FakePg(new Set(["elevate_support_session", "grant_support_membership", "revoke_support_memberships"]));
    const repo = new PostgresImpersonationRepository(db);
    expect(await repo.elevateSupportSession("u-1", "s-1", "segundo motivo")).toEqual({ availability: "not_migrated", entry: null });
    expect(await repo.grantSupportMembership("u-1", "s-1")).toEqual({ availability: "not_migrated", granted: false });
    expect(await repo.revokeSupportMemberships("u-1", null)).toEqual({ availability: "not_migrated", revoked: 0 });
    expect(db.aborted).toBe(false);
  });

  it("conceder y revocar leen el resultado real de la función", async () => {
    const db = new FakePg(new Set(), { grant_support_membership: [{ granted: true }], revoke_support_memberships: [{ revoked: 2 }] });
    const repo = new PostgresImpersonationRepository(db);
    expect((await repo.grantSupportMembership("u-1", "s-1")).granted).toBe(true);
    expect((await repo.revokeSupportMemberships("u-1", "s-1")).revoked).toBe(2);
  });
});
