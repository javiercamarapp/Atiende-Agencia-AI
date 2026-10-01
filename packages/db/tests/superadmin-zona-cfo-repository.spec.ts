// Adaptador Postgres de la zona CFO segura (SA-41): base sin migrar (42883/42P01/42703) con una sesion que
// reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession), tipado de errores de negocio,
// mapeo de filas y semantica del adaptador en memoria (misma que el SQL de 0034).
import { describe, expect, it } from "vitest";
import { InMemoryCfoZoneRepository, PostgresCfoRepository, PostgresCfoZoneRepository, SuperadminSeguridadError } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const MOTIVO = "Rol de solo lectura para la contadora externa del trimestre.";

describe("PostgresCfoZoneRepository -- base sin migrar", () => {
  it("los cinco metodos devuelven not_migrated Y dejan la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /cfo_zone_resolve_role/, respond: () => pgError("42883", "function core.cfo_zone_resolve_role(uuid) does not exist") },
      { match: /cfo_zone_log_access/, respond: () => pgError("42883", "function core.cfo_zone_log_access(uuid, text, text, jsonb) does not exist") },
      { match: /cfo_zone_set_role/, respond: () => pgError("42883", "function core.cfo_zone_set_role(uuid, uuid, text, text) does not exist") },
      { match: /list_cfo_access_log_for_superadmin/, respond: () => pgError("42883", "function core.list_cfo_access_log_for_superadmin(uuid, integer, bigint) does not exist") },
      { match: /list_cfo_zone_roles_for_superadmin/, respond: () => pgError("42P01", 'relation "core.cfo_zone_role" does not exist') },
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresCfoZoneRepository(session);
    await expect(repo.resolveRole("u1")).resolves.toEqual({ availability: "not_migrated", rol: null });
    await expect(repo.logAccess("u1", "consulta", "cfo/dashboard", {})).resolves.toEqual({ availability: "not_migrated", seq: null });
    await expect(repo.setRole("u1", "u2", "finanzas", MOTIVO)).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.listAccessLog("u1", 10, null)).resolves.toEqual({ availability: "not_migrated", entries: [] });
    await expect(repo.listRoles("u1")).resolves.toEqual({ availability: "not_migrated", roles: [] });
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(5);
  });

  it("MISMA transaccion: 0030 aplicada y 0034 sin aplicar -> la lectura del CFO anterior y la posterior siguen vivas", async () => {
    const session = new AbortAwareFakeSession([
      { match: /cfo_zone_resolve_role/, respond: () => pgError("42883", "function core.cfo_zone_resolve_role(uuid) does not exist") },
      { match: /list_billing_snapshots_for_superadmin/, respond: () => [] },
    ]);
    const cfo = new PostgresCfoRepository(session);
    const zona = new PostgresCfoZoneRepository(session);
    await expect(cfo.listSnapshots("u1", "2026-08-01", "2026-09-01")).resolves.toMatchObject({ availability: "available" });
    await expect(zona.resolveRole("u1")).resolves.toEqual({ availability: "not_migrated", rol: null });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK.
    await expect(cfo.listSnapshots("u1", "2026-08-01", "2026-09-01")).resolves.toMatchObject({ availability: "available" });
  });

  it("un 42883 que NO es de migracion (operador) no se enmascara como not_migrated", async () => {
    const s = new AbortAwareFakeSession([{ match: /cfo_zone_resolve_role/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresCfoZoneRepository(s).resolveRole("u1")).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresCfoZoneRepository -- errores de negocio y mapeo", () => {
  it("42501 -> forbidden y 22023 -> invalid (tipados, no 500)", async () => {
    const forbidden = new AbortAwareFakeSession([{ match: /cfo_zone_log_access/, respond: () => pgError("42501", "cfo_zone_log_access: caller binding invalido o sin rol en la zona CFO") }]);
    await expect(new PostgresCfoZoneRepository(forbidden).logAccess("u1", "consulta", "x", {})).rejects.toMatchObject({ code: "forbidden" });
    const invalid = new AbortAwareFakeSession([{ match: /cfo_zone_set_role/, respond: () => pgError("22023", "cfo_zone_set_role: motivo obligatorio") }]);
    const err = await new PostgresCfoZoneRepository(invalid).setRole("u1", "u2", "finanzas", "corto").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SuperadminSeguridadError);
    expect(err).toMatchObject({ code: "invalid" });
  });

  it("resolveRole solo acepta los dos roles conocidos (cualquier otro valor -> null)", async () => {
    const mk = (rol: string | null) => new AbortAwareFakeSession([{ match: /cfo_zone_resolve_role/, respond: () => [{ rol }] }]);
    await expect(new PostgresCfoZoneRepository(mk("finanzas")).resolveRole("u1")).resolves.toEqual({ availability: "available", rol: "finanzas" });
    await expect(new PostgresCfoZoneRepository(mk("superadmin")).resolveRole("u1")).resolves.toEqual({ availability: "available", rol: "superadmin" });
    await expect(new PostgresCfoZoneRepository(mk("dios")).resolveRole("u1")).resolves.toEqual({ availability: "available", rol: null });
    await expect(new PostgresCfoZoneRepository(mk(null)).resolveRole("u1")).resolves.toEqual({ availability: "available", rol: null });
  });

  it("logAccess devuelve el seq numerico; listAccessLog y listRoles mapean filas y fechas", async () => {
    const session = new AbortAwareFakeSession([
      { match: /cfo_zone_log_access/, respond: () => [{ seq: "41" }] },
      {
        match: /list_cfo_access_log_for_superadmin/,
        respond: () => [{ seq: "41", actor_user_id: "u1", actor_rol: "finanzas", accion: "exportacion", recurso: "pyl/export.csv", filtros: null, occurred_at: "2026-09-30T12:00:00.000Z" }],
      },
      { match: /list_cfo_zone_roles_for_superadmin/, respond: () => [{ staff_user_id: "u2", email: "c@x.mx", rol: "finanzas", assigned_by: "u1", reason: MOTIVO, created_at: "2026-09-29T10:00:00.000Z" }] },
    ]);
    const repo = new PostgresCfoZoneRepository(session);
    await expect(repo.logAccess("u1", "consulta", "cfo/dashboard", { mes: "2026-09" })).resolves.toEqual({ availability: "available", seq: 41 });
    const log = await repo.listAccessLog("u1", 50, null);
    expect(log.entries).toEqual([{ seq: 41, actorUserId: "u1", actorRol: "finanzas", accion: "exportacion", recurso: "pyl/export.csv", filtros: {}, occurredAtMs: Date.parse("2026-09-30T12:00:00.000Z") }]);
    const roles = await repo.listRoles("u1");
    expect(roles.roles[0]).toMatchObject({ staffUserId: "u2", email: "c@x.mx", rol: "finanzas", assignedBy: "u1", createdAtMs: Date.parse("2026-09-29T10:00:00.000Z") });
  });
});

describe("InMemoryCfoZoneRepository -- misma semantica que el SQL", () => {
  function repo() {
    const r = new InMemoryCfoZoneRepository({ now: () => 1_000 });
    r.seedSuperadmin("jefe");
    r.seedSuperadmin("conta");
    r.seedSuperadmin("otra");
    return r;
  }

  it("resolveRole: superadmin, finanzas o null (no superadmin)", async () => {
    const r = repo();
    r.seedRole("conta");
    expect((await r.resolveRole("jefe")).rol).toBe("superadmin");
    expect((await r.resolveRole("conta")).rol).toBe("finanzas");
    expect((await r.resolveRole("staff")).rol).toBeNull();
  });

  it("logAccess: sin rol -> forbidden; accion de rol no se fabrica; filtros acotados", async () => {
    const r = repo();
    await expect(r.logAccess("staff", "consulta", "x", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.logAccess("jefe", "rol_asignado" as never, "x", {})).rejects.toMatchObject({ code: "invalid" });
    await expect(r.logAccess("jefe", "consulta", "   ", {})).rejects.toMatchObject({ code: "invalid" });
    await expect(r.logAccess("jefe", "consulta", "x", { a: "z".repeat(2100) })).rejects.toMatchObject({ code: "invalid" });
    await expect(r.logAccess("jefe", "consulta", "x", { mes: "2026-09" })).resolves.toEqual({ availability: "available", seq: 1 });
  });

  it("setRole: solo superadmin completo, no a si mismo, destino superadmin, motivo >= 20; el restringido ya no puede asignar", async () => {
    const r = repo();
    await expect(r.setRole("jefe", "jefe", "finanzas", MOTIVO)).rejects.toMatchObject({ code: "invalid" });
    await expect(r.setRole("jefe", "staff", "finanzas", MOTIVO)).rejects.toMatchObject({ code: "invalid" });
    await expect(r.setRole("jefe", "conta", "finanzas", "corto")).rejects.toMatchObject({ code: "invalid" });
    await expect(r.setRole("staff", "conta", "finanzas", MOTIVO)).rejects.toMatchObject({ code: "forbidden" });
    await r.setRole("jefe", "conta", "finanzas", MOTIVO);
    await expect(r.setRole("conta", "otra", "finanzas", MOTIVO)).rejects.toMatchObject({ code: "forbidden" });
    await expect(r.setRole("conta", "conta", null, MOTIVO)).rejects.toMatchObject({ code: "forbidden" });
    expect((await r.listAccessLog("jefe", 10, null)).entries.map((e) => e.accion)).toEqual(["rol_asignado"]);
    await r.setRole("jefe", "conta", null, MOTIVO);
    expect((await r.resolveRole("conta")).rol).toBe("superadmin");
  });

  it("las lecturas de bitacora y roles dan cero filas al rol finanzas y a quien no es superadmin", async () => {
    const r = repo();
    await r.logAccess("jefe", "consulta", "cfo/dashboard", {});
    r.seedRole("conta");
    expect((await r.listAccessLog("jefe", 10, null)).entries).toHaveLength(1);
    expect((await r.listAccessLog("conta", 10, null)).entries).toHaveLength(0);
    expect((await r.listAccessLog("staff", 10, null)).entries).toHaveLength(0);
    expect((await r.listRoles("conta")).roles).toHaveLength(0);
    expect((await r.listRoles("jefe")).roles).toHaveLength(1);
  });
});
