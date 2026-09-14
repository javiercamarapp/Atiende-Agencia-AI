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
