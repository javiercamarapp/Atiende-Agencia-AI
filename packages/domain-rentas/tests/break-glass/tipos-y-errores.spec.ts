import { describe, expect, it } from "vitest";
import { BREAK_GLASS_RESOURCE_TYPES, isBreakGlassResourceType } from "../../src/break-glass/tipos.ts";
import { BreakGlassError, BreakGlassOrganizationRequiredError, BreakGlassReasonRequiredError } from "../../src/break-glass/errors.ts";

describe("isBreakGlassResourceType", () => {
  it("acepta cada valor declarado en BREAK_GLASS_RESOURCE_TYPES", () => {
    for (const tipo of BREAK_GLASS_RESOURCE_TYPES) {
      expect(isBreakGlassResourceType(tipo)).toBe(true);
    }
  });

  it("rechaza un valor arbitrario que no está en la lista (mismo conjunto que el CHECK de la migración)", () => {
    expect(isBreakGlassResourceType("todo_el_tenant_sin_categoria")).toBe(false);
    expect(isBreakGlassResourceType("")).toBe(false);
  });
});

describe("jerarquía de errores del break-glass", () => {
  it("BreakGlassReasonRequiredError y BreakGlassOrganizationRequiredError son BreakGlassError con `code` propio", () => {
    const razonError = new BreakGlassReasonRequiredError(3, 20);
    const orgError = new BreakGlassOrganizationRequiredError();

    expect(razonError).toBeInstanceOf(BreakGlassError);
    expect(orgError).toBeInstanceOf(BreakGlassError);
    expect(razonError.code).toBe("break_glass_reason_required");
    expect(orgError.code).toBe("break_glass_organization_required");
    // `name` distinto por subclase -- para que un log/monitoring que agrupe por
    // `err.name` no mezcle las dos causas.
    expect(razonError.name).toBe("BreakGlassReasonRequiredError");
    expect(orgError.name).toBe("BreakGlassOrganizationRequiredError");
  });
});
