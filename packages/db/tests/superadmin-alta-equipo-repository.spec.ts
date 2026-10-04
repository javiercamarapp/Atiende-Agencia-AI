// Repositorio del alta de equipo por superadmin (0053): lectura y aviso degradan sin la migracion con una sesion que reproduce el estado
// ABORTADO real de una transaccion (AbortAwareFakeSession); las mutaciones traducen los rechazos de la base a errores con codigo estable.
import { describe, expect, it } from "vitest";
import { EquipoInvitacionError, EquipoNoDisponibleError, InMemoryOrgEquipoRepository, PostgresOrgEquipoRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const ENTRADA = { organizationId: "o1", email: "a@b.mx", verticalRole: "owner", propertyIds: null, tokenHash: "h".repeat(64), motivo: "Alta del equipo inicial del go-live", confirmarSegundoOwner: false };

describe("PostgresOrgEquipoRepository -- lectura y aviso de sistema", () => {
  it("MISMA transaccion: la lectura sin la 0053 no tumba la consulta que se hace despues (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_org_team_for_superadmin/, respond: () => pgError("42883", "function core.list_org_team_for_superadmin(uuid, uuid) does not exist") },
      { match: /superadmin_invite_acceptance_for_system/, respond: () => [{ invite_id: "i1", organization_id: "o1" }] },
    ]);
    const repo = new PostgresOrgEquipoRepository(session);
    await expect(repo.leer("u1", "o1")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 y el COMMIT daria ROLLBACK de todo lo escrito en el request.
    await expect(repo.aceptacionParaSistema("hash")).resolves.toEqual({ ok: true, data: { inviteId: "i1", organizationId: "o1" } });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(1);
  });

  it("un error que no es de migracion deja la fuente en 'error' (no se enmascara como no_migrado)", async () => {
    const session = new AbortAwareFakeSession([{ match: /list_org_team_for_superadmin/, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    await expect(new PostgresOrgEquipoRepository(session).leer("u1", "o1")).resolves.toEqual({ ok: false, razon: "error" });
  });

  it("organizacion inexistente o caller sin permiso (la funcion devuelve null) es data null; el aviso sin invitacion de superadmin tambien", async () => {
    const session = new AbortAwareFakeSession([
      { match: /list_org_team_for_superadmin/, respond: () => [{ equipo: null }] },
      { match: /superadmin_invite_acceptance_for_system/, respond: () => [] },
    ]);
    const repo = new PostgresOrgEquipoRepository(session);
    await expect(repo.leer("u1", "o1")).resolves.toEqual({ ok: true, data: null });
    await expect(repo.aceptacionParaSistema("hash")).resolves.toEqual({ ok: true, data: null });
  });
});

describe("PostgresOrgEquipoRepository -- mutaciones", () => {
  it("traduce los rechazos de la base a codigos estables (42501, 22023, P0002, 23505, 55000)", async () => {
    const casos: Array<[string, string, string]> = [
      ["42501", "forbidden", "x"],
      ["22023", "validation", "superadmin_invite_staff: rol fuera de la lista blanca (owner, admin, staff, repartidor)"],
      ["P0002", "not_found", "superadmin_resend_staff_invite: invitacion no encontrada o ya no esta pendiente"],
      ["23505", "conflict", "superadmin_invite_staff: ese correo ya es miembro de la organizacion"],
      ["55000", "segundo_owner", "superadmin_invite_staff: la organizacion ya tiene un owner"],
    ];
    for (const [code, codigo, mensaje] of casos) {
      const session = new AbortAwareFakeSession([{ match: /superadmin_invite_staff/, respond: () => pgError(code, mensaje) }]);
      const err = await new PostgresOrgEquipoRepository(session).invitar("u1", ENTRADA).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EquipoInvitacionError);
      expect((err as EquipoInvitacionError).codigo).toBe(codigo);
      expect((err as Error).message).not.toContain("superadmin_invite_staff:");
    }
  });

  it("sin la 0053 (42883) las tres mutaciones lanzan EquipoNoDisponibleError; un error desconocido se relanza tal cual", async () => {
    const sinMigrar = new AbortAwareFakeSession([{ match: /superadmin_/, respond: () => pgError("42883", "function core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean) does not exist") }]);
    await expect(new PostgresOrgEquipoRepository(sinMigrar).invitar("u1", ENTRADA)).rejects.toBeInstanceOf(EquipoNoDisponibleError);
    const sinMigrar2 = new AbortAwareFakeSession([{ match: /superadmin_/, respond: () => pgError("42883", "function core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text) does not exist") }]);
    await expect(new PostgresOrgEquipoRepository(sinMigrar2).reenviar("u1", "o1", "i1", "h", "motivo")).rejects.toBeInstanceOf(EquipoNoDisponibleError);
    const sinMigrar3 = new AbortAwareFakeSession([{ match: /superadmin_/, respond: () => pgError("42883", "function core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text) does not exist") }]);
    await expect(new PostgresOrgEquipoRepository(sinMigrar3).revocar("u1", "o1", "i1", "motivo")).rejects.toBeInstanceOf(EquipoNoDisponibleError);
    const raro = new AbortAwareFakeSession([{ match: /superadmin_/, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresOrgEquipoRepository(raro).invitar("u1", ENTRADA)).rejects.toMatchObject({ code: "57014" });
  });

  it("invitar mapea la fila devuelta (sin token_hash) y manda las sucursales como arreglo uuid", async () => {
    const session = new AbortAwareFakeSession([
      { match: /superadmin_invite_staff/, respond: () => [{ id: "i1", email: "a@b.mx", vertical_role: "staff", platform_role: "member", property_ids: ["p1"], status: "pending", expires_at: new Date("2026-10-11T00:00:00Z"), created_at: "2026-10-04T00:00:00Z" }] },
    ]);
    const r = await new PostgresOrgEquipoRepository(session).invitar("u1", { ...ENTRADA, verticalRole: "staff", propertyIds: ["p1"] });
    expect(r).toEqual({ id: "i1", email: "a@b.mx", verticalRole: "staff", platformRole: "member", propertyIds: ["p1"], status: "pending", expiresAt: "2026-10-11T00:00:00.000Z", createdAt: "2026-10-04T00:00:00.000Z" });
    expect(JSON.stringify(r)).not.toContain("token");
  });
});

describe("InMemoryOrgEquipoRepository", () => {
  it("un caller que no es superadmin recibe forbidden y lectura sin datos", async () => {
    const repo = new InMemoryOrgEquipoRepository();
    repo.seedOrganizacion("o1", "restaurantes");
    await expect(repo.invitar("intruso", ENTRADA)).rejects.toMatchObject({ codigo: "forbidden" });
    await expect(repo.leer("intruso", "o1")).resolves.toEqual({ ok: true, data: null });
  });
});
