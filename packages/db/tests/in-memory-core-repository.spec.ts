import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "../src/in-memory-core-repository.ts";
import { StaffInviteInvalidError } from "../src/core-repository.ts";

describe("InMemoryCoreRepository", () => {
  it("resuelve staff por email y por id, null si no existe", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addStaff({
      id: "staff-1",
      email: "dueño@lostaquitos.mx",
      fullName: "Dueño de prueba",
      passwordHash: "scrypt$16384$8$1$aa$bb",
      createdVia: "seed",
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await repo.findStaffByEmail("dueño@lostaquitos.mx"))?.id).toBe("staff-1");
    expect(await repo.findStaffByEmail("no-existe@x.mx")).toBeNull();
    expect((await repo.findStaffById("staff-1"))?.email).toBe("dueño@lostaquitos.mx");
    expect(await repo.findStaffById("no-existe")).toBeNull();
  });

  it("findMembershipsByUserId trae el nombre/slug/vertical de la organización unida", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addOrganization({ id: "org-1", slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
    repo.addStaff({
      id: "staff-1",
      email: "a@x.mx",
      fullName: "A",
      passwordHash: null,
      createdVia: "invite",
      emailVerifiedAt: null,
    });
    repo.addMembership({
      userId: "staff-1",
      organizationId: "org-1",
      platformRole: "owner",
      verticalRole: "owner",
      propertyIds: null,
    });

    const memberships = await repo.findMembershipsByUserId("staff-1");
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({
      organizationId: "org-1",
      organizationSlug: "los-taquitos-de-pm",
      vertical: "restaurantes",
      platformRole: "owner",
      propertyIds: null,
    });
  });

  it("rechaza un segundo staff_user con el mismo email (igual que el UNIQUE real)", () => {
    const repo = new InMemoryCoreRepository();
    repo.addStaff({ id: "1", email: "dup@x.mx", fullName: "A", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    expect(() =>
      repo.addStaff({ id: "2", email: "dup@x.mx", fullName: "B", passwordHash: null, createdVia: "seed", emailVerifiedAt: null }),
    ).toThrow();
  });
});

// Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
// hoteles") — ver packages/db/migrations/0003_refresh_token_revocation.sql.
describe("InMemoryCoreRepository — revocación de refresh tokens (logout)", () => {
  it("un jti no revocado responde false; tras revokeRefreshToken responde true", async () => {
    const repo = new InMemoryCoreRepository();
    expect(await repo.isRefreshTokenRevoked("jti-1")).toBe(false);

    await repo.revokeRefreshToken({ jti: "jti-1", userId: "staff-1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    expect(await repo.isRefreshTokenRevoked("jti-1")).toBe(true);
  });

  it("revocar dos veces el mismo jti no lanza (idempotente, igual que el logout real)", async () => {
    const repo = new InMemoryCoreRepository();
    const input = { jti: "jti-2", userId: "staff-1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    await expect(repo.revokeRefreshToken(input)).resolves.toBeUndefined();
    await expect(repo.revokeRefreshToken(input)).resolves.toBeUndefined();
    expect(await repo.isRefreshTokenRevoked("jti-2")).toBe(true);
  });

  it("revocar un jti no afecta a otro jti distinto (revocación selectiva, no todo el usuario)", async () => {
    const repo = new InMemoryCoreRepository();
    await repo.revokeRefreshToken({ jti: "jti-a", userId: "staff-1", expiresAt: new Date().toISOString() });
    expect(await repo.isRefreshTokenRevoked("jti-a")).toBe(true);
    expect(await repo.isRefreshTokenRevoked("jti-b")).toBe(false);
  });
});

// Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar sesiones
// activas de un usuario") — ver packages/db/migrations/0006_revoke_all_sessions.sql.
describe("InMemoryCoreRepository — revocación de TODAS las sesiones de un usuario", () => {
  it("findStaffById/findStaffByEmail traen sessionsRevokedAt null antes de revocar", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addStaff({ id: "staff-1", email: "a@x.mx", fullName: "A", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });

    expect((await repo.findStaffById("staff-1"))?.sessionsRevokedAt).toBeNull();
    expect((await repo.findStaffByEmail("a@x.mx"))?.sessionsRevokedAt).toBeNull();
  });

  it("revokeAllRefreshTokens fija sessionsRevokedAt (ISO 8601) para ESE usuario, sin tocar a otros", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addStaff({ id: "staff-1", email: "a@x.mx", fullName: "A", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });
    repo.addStaff({ id: "staff-2", email: "b@x.mx", fullName: "B", passwordHash: null, createdVia: "seed", emailVerifiedAt: null });

    await repo.revokeAllRefreshTokens("staff-1");

    const revoked = await repo.findStaffById("staff-1");
    expect(typeof revoked?.sessionsRevokedAt).toBe("string");
    expect(new Date(revoked!.sessionsRevokedAt!).toString()).not.toBe("Invalid Date");

    // staff-2 nunca se tocó.
    expect((await repo.findStaffById("staff-2"))?.sessionsRevokedAt).toBeNull();
  });
});

describe("InMemoryCoreRepository — invitación de staff (Fase 10)", () => {
  function seedOwner(repo: InMemoryCoreRepository) {
    repo.addOrganization({ id: "org-1", slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
    repo.addStaff({ id: "owner-1", email: "dueño@x.mx", fullName: "Dueño", passwordHash: "hash", createdVia: "seed", emailVerifiedAt: "2026-01-01T00:00:00.000Z" });
    repo.addMembership({ userId: "owner-1", organizationId: "org-1", platformRole: "owner", verticalRole: "owner", propertyIds: null });
  }

  it("createStaffInvite -> listPendingStaffInvites la trae 'pending'", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);

    const invite = await repo.createStaffInvite({
      email: "nuevo@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "staff",
      propertyIds: null,
      tokenHash: "hash-token-1",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(invite.status).toBe("pending");

    const pending = await repo.listPendingStaffInvites("org-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.email).toBe("nuevo@x.mx");
  });

  it("acceptStaffInvite crea el staff_user y la membership, y marca la invitación 'accepted'", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);
    await repo.createStaffInvite({
      email: "repartidor@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "repartidor",
      propertyIds: ["prop-1"],
      tokenHash: "hash-token-2",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const result = await repo.acceptStaffInvite({ tokenHash: "hash-token-2", fullName: "Repartidor Nuevo", passwordHash: "hash-nuevo" });
    expect(result.email).toBe("repartidor@x.mx");
    expect(result.organizationId).toBe("org-1");
    expect(result.vertical).toBe("restaurantes");
    expect(result.verticalRole).toBe("repartidor");
    expect(result.propertyIds).toEqual(["prop-1"]);

    const staff = await repo.findStaffByEmail("repartidor@x.mx");
    expect(staff?.id).toBe(result.staffId);
    expect(staff?.createdVia).toBe("invite");

    const memberships = await repo.findMembershipsByUserId(result.staffId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organizationId: "org-1", verticalRole: "repartidor", platformRole: "member" });

    const pending = await repo.listPendingStaffInvites("org-1");
    expect(pending).toHaveLength(0);
  });

  it("acceptStaffInvite lanza StaffInviteInvalidError si el token no existe", async () => {
    const repo = new InMemoryCoreRepository();
    await expect(repo.acceptStaffInvite({ tokenHash: "no-existe", fullName: "X", passwordHash: "h" })).rejects.toThrow(StaffInviteInvalidError);
  });

  it("acceptStaffInvite lanza StaffInviteInvalidError si ya fue aceptada (no se puede reusar)", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);
    await repo.createStaffInvite({
      email: "una-vez@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "staff",
      propertyIds: null,
      tokenHash: "hash-token-3",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await repo.acceptStaffInvite({ tokenHash: "hash-token-3", fullName: "Una Vez", passwordHash: "h" });
    await expect(repo.acceptStaffInvite({ tokenHash: "hash-token-3", fullName: "Otra Vez", passwordHash: "h" })).rejects.toThrow(StaffInviteInvalidError);
  });

  it("acceptStaffInvite lanza StaffInviteInvalidError si ya expiró", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);
    await repo.createStaffInvite({
      email: "expirada@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "staff",
      propertyIds: null,
      tokenHash: "hash-token-4",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(repo.acceptStaffInvite({ tokenHash: "hash-token-4", fullName: "Tarde", passwordHash: "h" })).rejects.toThrow(StaffInviteInvalidError);
  });

  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI"): a diferencia de `createStaffInvite`/`listPendingStaffInvites`
  // (invitaciones PENDIENTES, sin membership real todavía), esto lista miembros YA
  // ACEPTADOS -- el selector real de `assign-repartidor` necesita esto, no invitaciones.
  it("listMembersByVerticalRole trae solo los miembros YA aceptados con ese vertical_role exacto de esa organización", async () => {
    const repo = new InMemoryCoreRepository();
    repo.addOrganization({ id: "org-1", slug: "los-taquitos-de-pm", name: "Los Taquitos de PM", vertical: "restaurantes" });
    repo.addOrganization({ id: "org-2", slug: "otro", name: "Otro Restaurante", vertical: "restaurantes" });
    seedOwner(repo);
    repo.addStaff({ id: "rep-1", email: "rep1@x.mx", fullName: "Repartidor Uno", passwordHash: "h", createdVia: "invite", emailVerifiedAt: "2026-01-01T00:00:00.000Z" });
    repo.addMembership({ userId: "rep-1", organizationId: "org-1", platformRole: "member", verticalRole: "repartidor", propertyIds: ["prop-1"] });
    repo.addStaff({ id: "staff-a", email: "staff-a@x.mx", fullName: "Staff A", passwordHash: "h", createdVia: "seed", emailVerifiedAt: null });
    repo.addMembership({ userId: "staff-a", organizationId: "org-1", platformRole: "member", verticalRole: "staff", propertyIds: null });
    repo.addStaff({ id: "rep-otra-org", email: "rep-otra@x.mx", fullName: "Repartidor de otra org", passwordHash: "h", createdVia: "seed", emailVerifiedAt: null });
    repo.addMembership({ userId: "rep-otra-org", organizationId: "org-2", platformRole: "member", verticalRole: "repartidor", propertyIds: null });

    const repartidores = await repo.listMembersByVerticalRole("org-1", "repartidor");
    expect(repartidores).toHaveLength(1);
    expect(repartidores[0]).toMatchObject({ userId: "rep-1", email: "rep1@x.mx", fullName: "Repartidor Uno", propertyIds: ["prop-1"] });

    // Ni el "staff" de gestión de la misma org, ni el repartidor de OTRA org, aparecen.
    expect(repartidores.map((m) => m.userId)).not.toContain("staff-a");
    expect(repartidores.map((m) => m.userId)).not.toContain("rep-otra-org");
  });

  it("listMembersByVerticalRole -- una invitación todavía 'pending' (sin aceptar) nunca cuenta como miembro", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);
    await repo.createStaffInvite({
      email: "pendiente@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "repartidor",
      propertyIds: null,
      tokenHash: "hash-pendiente",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(await repo.listMembersByVerticalRole("org-1", "repartidor")).toEqual([]);
  });

  it("revokeStaffInvite marca 'revoked' y ya no aparece en listPendingStaffInvites; devuelve false si no existe/no es de esa org", async () => {
    const repo = new InMemoryCoreRepository();
    seedOwner(repo);
    const invite = await repo.createStaffInvite({
      email: "revocada@x.mx",
      organizationId: "org-1",
      platformRole: "member",
      verticalRole: "staff",
      propertyIds: null,
      tokenHash: "hash-token-5",
      invitedBy: "owner-1",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(await repo.revokeStaffInvite(invite.id, "otra-org")).toBe(false);
    expect(await repo.revokeStaffInvite("id-inexistente", "org-1")).toBe(false);

    expect(await repo.revokeStaffInvite(invite.id, "org-1")).toBe(true);
    expect(await repo.listPendingStaffInvites("org-1")).toHaveLength(0);
    expect(await repo.revokeStaffInvite(invite.id, "org-1")).toBe(false);
  });
});
