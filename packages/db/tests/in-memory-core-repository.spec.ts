import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "../src/in-memory-core-repository.ts";

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
