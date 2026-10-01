// Adaptadores Postgres: base sin migrar (42883/42P01/42703) con una sesion que
// reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession) --
// una sesion falsa plana no distinguiria una implementacion sin SAVEPOINT -- y
// traduccion de SQLSTATE de negocio a errores tipados. Mas la semantica de los
// adaptadores en memoria que usan los tests de rutas.
import { describe, expect, it } from "vitest";
import {
  InMemoryMfaRepository,
  InMemoryOrgAdminRepository,
  InMemoryPlatformSwitchRepository,
  PostgresMfaRepository,
  PostgresOrgAdminRepository,
  PostgresPlatformSwitchRepository,
  SuperadminSeguridadError,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingFn = (name: string) => pgError("42883", `function core.${name}(uuid) does not exist`);

describe("Postgres*Repository -- base sin migrar", () => {
  it("MFA: getFactor sin migracion devuelve not_migrated Y deja la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /superadmin_mfa_get_factor/, respond: () => missingFn("superadmin_mfa_get_factor") },
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresMfaRepository(session);
    await expect(repo.getFactor("u1")).resolves.toEqual({ availability: "not_migrated", factor: null });
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("interruptores: getBlocked y list sin migracion -> vacio honesto + sesion viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /get_blocked_platform_switches/, respond: () => pgError("42P01", 'relation "core.platform_switch" does not exist') },
      { match: /list_platform_switches_for_superadmin/, respond: () => pgError("42703", "column x does not exist") },
    ]);
    const repo = new PostgresPlatformSwitchRepository(session);
    await expect(repo.getBlocked()).resolves.toEqual({ availability: "not_migrated", blocked: [] });
    await expect(repo.list("u1")).resolves.toEqual({ availability: "not_migrated", switches: [] });
  });

  it("organizaciones: request/confirm/cancel/list sin migracion -> not_migrated, nunca exito simulado", async () => {
    const session = new AbortAwareFakeSession([
      { match: /request_org_admin_action/, respond: () => missingFn("request_org_admin_action") },
      { match: /confirm_org_admin_action/, respond: () => missingFn("confirm_org_admin_action") },
      { match: /cancel_org_admin_action/, respond: () => missingFn("cancel_org_admin_action") },
      { match: /list_org_admin_actions_for_superadmin/, respond: () => missingFn("list_org_admin_actions_for_superadmin") },
    ]);
    const repo = new PostgresOrgAdminRepository(session);
    await expect(repo.request("u1", "suspender", "o1", {}, "motivo suficientemente largo para pasar")).resolves.toEqual({ availability: "not_migrated", action: null });
    await expect(repo.confirm("u1", "a1")).resolves.toEqual({ availability: "not_migrated", action: null });
    await expect(repo.cancel("u1", "a1")).resolves.toEqual({ availability: "not_migrated", action: null });
    await expect(repo.list("u1")).resolves.toEqual({ availability: "not_migrated", actions: [] });
  });

  it("un 42883 que NO es 'function ... does not exist' (bug de tipos) NO se enmascara como migracion pendiente", async () => {
    const session = new AbortAwareFakeSession([{ match: /superadmin_mfa_get_factor/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresMfaRepository(session).getFactor("u1")).rejects.toThrow(/operator does not exist/);
  });
});

describe("Postgres*Repository -- errores de negocio tipados", () => {
  const cases: Array<[string, "forbidden" | "invalid" | "not_found" | "conflict"]> = [
    ["42501", "forbidden"],
    ["22023", "invalid"],
    ["23514", "invalid"],
    ["P0002", "not_found"],
    ["55006", "conflict"],
    ["23505", "conflict"],
  ];
  for (const [sqlstate, code] of cases) {
    it(`SQLSTATE ${sqlstate} -> ${code} (y la sesion queda usable)`, async () => {
      const session = new AbortAwareFakeSession([
        { match: /set_platform_switch/, respond: () => pgError(sqlstate, "falla de negocio") },
        { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
      ]);
      const repo = new PostgresPlatformSwitchRepository(session);
      await expect(repo.setSwitch("u1", "global", "llm", true, "motivo suficientemente largo")).rejects.toMatchObject({ name: "SuperadminSeguridadError", code });
      await expect(session.query("select 1 as sigue_viva")).resolves.toBeDefined();
    });
  }

  it("un error desconocido se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([{ match: /set_platform_switch/, respond: () => pgError("XX000", "boom") }]);
    await expect(new PostgresPlatformSwitchRepository(session).setSwitch("u1", "global", "llm", true, "motivo suficientemente largo")).rejects.toThrow("boom");
  });
});

describe("InMemoryMfaRepository", () => {
  it("activa con el primer acierto, rechaza reuso, bloquea a los 5 fallos y reinicia con acierto", async () => {
    let now = 1_000_000;
    const repo = new InMemoryMfaRepository({ now: () => now });
    repo.seedSuperadmin("u1");
    await repo.beginEnrollment("u1", "cipher");
    expect((await repo.recordAttempt("u1", true, 10)).result).toBe("activated");
    expect((await repo.recordAttempt("u1", true, 10)).result).toBe("replay");
    expect((await repo.recordAttempt("u1", true, 9)).result).toBe("replay");
    expect((await repo.recordAttempt("u1", true, 11)).result).toBe("ok");
    for (let i = 0; i < 4; i++) expect((await repo.recordAttempt("u1", false, null)).result).toBe("invalid");
    expect((await repo.recordAttempt("u1", false, null)).result).toBe("locked");
    expect((await repo.recordAttempt("u1", true, 99)).result).toBe("locked");
    now += 16 * 60_000;
    expect((await repo.recordAttempt("u1", true, 99)).result).toBe("ok");
  });
  it("no re-enrola un factor activo, ni a quien no es superadmin; reset solo por otro superadmin con motivo", async () => {
    const repo = new InMemoryMfaRepository();
    repo.seedSuperadmin("u1");
    repo.seedSuperadmin("u2");
    await expect(repo.beginEnrollment("zz", "c")).rejects.toMatchObject({ code: "forbidden" });
    await repo.beginEnrollment("u1", "cipher");
    await repo.recordAttempt("u1", true, 1);
    await expect(repo.beginEnrollment("u1", "otro")).rejects.toMatchObject({ code: "conflict" });
    await expect(repo.reset("u1", "u1", "motivo suficientemente largo aqui")).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.reset("u2", "u1", "corto")).rejects.toMatchObject({ code: "invalid" });
    await repo.reset("u2", "u1", "dispositivo perdido, verificado por llamada");
    expect((await repo.getFactor("u1")).factor).toBeNull();
    expect((await repo.listEvents("u2", "mfa")).events.map((e) => e.event)).toContain("mfa_reset");
    expect((await repo.listEvents("zz", "mfa")).events).toEqual([]);
  });
});

describe("InMemoryPlatformSwitchRepository", () => {
  it("valida claves, exige superadmin y motivo; getBlocked solo trae bloqueados", async () => {
    const repo = new InMemoryPlatformSwitchRepository();
    repo.seedSuperadmin("u1");
    const motivo = "motivo suficientemente largo";
    await expect(repo.setSwitch("zz", "global", "llm", true, motivo)).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.setSwitch("u1", "global", "llm", true, "corto")).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.setSwitch("u1", "cron", "/etc/passwd", true, motivo)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.setSwitch("u1", "agente", "Foo", true, motivo)).rejects.toMatchObject({ code: "invalid" });
    await repo.setSwitch("u1", "agente", "restaurantes:whatsapp_agent", true, motivo);
    await repo.setSwitch("u1", "cron", "/internal/whatsapp/dispatch", false, motivo);
    expect((await repo.getBlocked()).blocked).toEqual([{ scope: "agente", target: "restaurantes:whatsapp_agent" }]);
    expect((await repo.list("zz")).switches).toEqual([]);
  });
});

describe("InMemoryOrgAdminRepository", () => {
  const motivo = "motivo suficientemente largo para la bitacora";
  function build() {
    const repo = new InMemoryOrgAdminRepository();
    repo.seedSuperadmin("u1");
    repo.seedSuperadmin("u2");
    repo.seedOrganization("oa", { vertical: "citas", name: "A", slug: "a", status: "active" });
    repo.seedOrganization("ob", { vertical: "citas", name: "B", slug: "b", status: "trial" });
    return repo;
  }
  it("suspender solo cambia al confirmar, y solo el solicitante confirma; reactivar restaura el estado previo", async () => {
    const repo = build();
    const { action } = await repo.request("u1", "suspender", "ob", {}, motivo);
    expect(repo.organizationStatus("ob")).toBe("trial");
    await expect(repo.confirm("u2", action!.id)).rejects.toMatchObject({ code: "forbidden" });
    await repo.confirm("u1", action!.id);
    expect(repo.organizationStatus("ob")).toBe("suspended");
    expect(repo.organizationStatus("oa")).toBe("active");
    const re = await repo.request("u1", "reactivar", "ob", {}, motivo);
    await repo.confirm("u1", re.action!.id);
    expect(repo.organizationStatus("ob")).toBe("trial");
  });
  it("una pendiente por organizacion, cancelar, doble confirmacion y vencimiento", async () => {
    let now = 0;
    const repo = new InMemoryOrgAdminRepository({ now: () => now });
    repo.seedSuperadmin("u1");
    repo.seedOrganization("oa", { vertical: "citas", name: "A", slug: "a", status: "active" });
    const first = await repo.request("u1", "suspender", "oa", {}, motivo);
    await expect(repo.request("u1", "cambiar_plan", "oa", { plan: "trial" }, motivo)).rejects.toMatchObject({ code: "conflict" });
    await repo.cancel("u1", first.action!.id);
    await expect(repo.confirm("u1", first.action!.id)).rejects.toMatchObject({ code: "conflict" });
    const second = await repo.request("u1", "cambiar_plan", "oa", { plan: "trial" }, motivo);
    now += 11 * 60_000;
    const expired = await repo.confirm("u1", second.action!.id);
    expect(expired.action!.estado).toBe("expired");
    expect(repo.organizationStatus("oa")).toBe("active");
  });
  it("alta crea la organizacion en trial al confirmar; valida slug/vertical/duplicados", async () => {
    const repo = build();
    await expect(repo.request("u1", "alta", null, { vertical: "citas", name: "Nueva", slug: "Bad Slug" }, motivo)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.request("u1", "alta", null, { vertical: "pizzas", name: "Nueva", slug: "nueva" }, motivo)).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.request("u1", "alta", null, { vertical: "citas", name: "Nueva", slug: "a" }, motivo)).rejects.toMatchObject({ code: "conflict" });
    const { action } = await repo.request("u1", "alta", null, { vertical: "citas", name: "Nueva", slug: "nueva" }, motivo);
    expect(repo.organizationBySlug("nueva")).toBeUndefined();
    await repo.confirm("u1", action!.id);
    const id = repo.organizationBySlug("nueva")!;
    expect(repo.organizationStatus(id)).toBe("trial");
  });
  it("no superadmin: forbidden en escrituras y lista vacia", async () => {
    const repo = build();
    await expect(repo.request("zz", "suspender", "oa", {}, motivo)).rejects.toBeInstanceOf(SuperadminSeguridadError);
    expect((await repo.list("zz")).actions).toEqual([]);
  });
});
