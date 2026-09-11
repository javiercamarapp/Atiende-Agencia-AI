import { describe, expect, it } from "vitest";
import { LICITACIONES_ROLES, WRITE_ROLES, DECISION_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, isLicitacionesRole } from "../src/roles.ts";

describe("roles -- port literal de licitaciones/packages/db/src/roles.ts", () => {
  it("los 6 roles planos de organización completa", () => {
    expect(LICITACIONES_ROLES).toEqual(["owner", "admin", "analyst", "writer", "reviewer", "viewer"]);
  });

  it("WRITE_ROLES excluye solo viewer", () => {
    expect(WRITE_ROLES).toEqual(["owner", "admin", "analyst", "writer", "reviewer"]);
    expect(WRITE_ROLES).not.toContain("viewer");
  });

  it("DECISION_ROLES es un subconjunto estricto de WRITE_ROLES (nunca writer/reviewer solos)", () => {
    expect(DECISION_ROLES).toEqual(["owner", "admin", "analyst"]);
    for (const role of DECISION_ROLES) expect(WRITE_ROLES).toContain(role);
    expect(DECISION_ROLES).not.toContain("writer");
    expect(DECISION_ROLES).not.toContain("reviewer");
  });

  it("todo rol de licitaciones tiene un platformRole mapeado", () => {
    for (const role of LICITACIONES_ROLES) expect(PLATFORM_ROLE_BY_VERTICAL_ROLE[role]).toBeDefined();
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.owner).toBe("owner");
    expect(PLATFORM_ROLE_BY_VERTICAL_ROLE.viewer).toBe("viewer");
  });

  it("isLicitacionesRole distingue roles válidos de inválidos", () => {
    expect(isLicitacionesRole("writer")).toBe(true);
    expect(isLicitacionesRole("frontdesk")).toBe(false);
  });
});
