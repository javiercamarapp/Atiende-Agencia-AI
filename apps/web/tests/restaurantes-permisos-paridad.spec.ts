// PL-23 -- la copia de la matriz que usa el panel (lib/permisos.ts) no puede desincronizarse de la del dominio (roles.ts).
import { describe, expect, it } from "vitest";
import { ACCIONES_RESTAURANTES, RESTAURANTES_ROLES } from "../../../packages/domain-restaurantes/src/roles.ts";
import { ROLES_POR_ACCION, puedeEn } from "../src/verticals/restaurantes/lib/permisos.ts";

describe("paridad de la matriz de permisos web <-> dominio", () => {
  it("mismas acciones y mismos roles por accion", () => {
    expect(Object.keys(ROLES_POR_ACCION).sort()).toEqual(Object.keys(ACCIONES_RESTAURANTES).sort());
    for (const [accion, roles] of Object.entries(ACCIONES_RESTAURANTES)) {
      expect([...ROLES_POR_ACCION[accion as keyof typeof ROLES_POR_ACCION]].sort()).toEqual([...roles].sort());
    }
  });

  it("puedeEn es fail-closed", () => {
    for (const rol of RESTAURANTES_ROLES) expect(puedeEn(rol, "catalogo.precio")).toBe(rol === "owner" || rol === "admin");
    expect(puedeEn(undefined, "catalogo.ver")).toBe(false);
    expect(puedeEn("superadmin", "catalogo.ver")).toBe(false);
  });
});
