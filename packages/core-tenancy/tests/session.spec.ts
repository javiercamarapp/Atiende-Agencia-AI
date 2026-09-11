import { describe, expect, it } from "vitest";
import {
  InsufficientPlatformRoleError,
  PropertyAccessDeniedError,
  assertPlatformRole,
  assertPropertyAccess,
  buildTenantSessionClaims,
  hasPropertyAccess,
  type Membership,
} from "../src/index.ts";

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    userId: "user-1",
    organizationId: "org-1",
    propertyIds: ["prop-1", "prop-2"],
    platformRole: "member",
    verticalRole: "frontdesk",
    ...overrides,
  };
}

describe("hasPropertyAccess", () => {
  it("permite acceso cuando la property está en la lista", () => {
    expect(hasPropertyAccess(membership(), "prop-1")).toBe(true);
  });

  it("niega acceso cuando la property no está en la lista", () => {
    expect(hasPropertyAccess(membership(), "prop-otra")).toBe(false);
  });

  it("propertyIds:null da acceso a CUALQUIER property (owner/admin de plataforma)", () => {
    expect(hasPropertyAccess(membership({ propertyIds: null }), "prop-cualquiera")).toBe(true);
  });

  it("una lista vacía de propertyIds no da acceso a nada", () => {
    expect(hasPropertyAccess(membership({ propertyIds: [] }), "prop-1")).toBe(false);
  });
});

describe("assertPropertyAccess", () => {
  it("no lanza cuando hay acceso", () => {
    expect(() => assertPropertyAccess(membership(), "prop-1")).not.toThrow();
  });

  it("lanza PropertyAccessDeniedError (fail-closed) cuando NO hay acceso", () => {
    expect(() => assertPropertyAccess(membership(), "prop-ajena")).toThrow(PropertyAccessDeniedError);
  });

  it("el error lleva el propertyId rechazado, para que el llamador pueda loguearlo sin volver a parsear el mensaje", () => {
    try {
      assertPropertyAccess(membership(), "prop-ajena");
      expect.unreachable("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(PropertyAccessDeniedError);
      expect((err as PropertyAccessDeniedError).propertyId).toBe("prop-ajena");
      expect((err as PropertyAccessDeniedError).code).toBe("property_access_denied");
    }
  });
});

describe("assertPlatformRole", () => {
  it("no lanza cuando el rol está permitido", () => {
    expect(() => assertPlatformRole(membership({ platformRole: "admin" }), ["owner", "admin"])).not.toThrow();
  });

  it("lanza InsufficientPlatformRoleError cuando el rol no está permitido", () => {
    expect(() => assertPlatformRole(membership({ platformRole: "viewer" }), ["owner", "admin"])).toThrow(
      InsufficientPlatformRoleError,
    );
  });
});

describe("buildTenantSessionClaims", () => {
  it("sin propertyId explícito, propaga el propertyIds completo de la membership", () => {
    const claims = buildTenantSessionClaims(membership(), "hoteles");
    expect(claims).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      vertical: "hoteles",
      propertyIds: ["prop-1", "prop-2"],
    });
  });

  it("con propertyId explícito y acceso válido, acota los claims a ESA sola property", () => {
    const claims = buildTenantSessionClaims(membership(), "hoteles", "prop-1");
    expect(claims.propertyIds).toEqual(["prop-1"]);
  });

  it("con propertyId explícito y SIN acceso, rechaza antes de construir los claims (fail-closed)", () => {
    expect(() => buildTenantSessionClaims(membership(), "hoteles", "prop-ajena")).toThrow(PropertyAccessDeniedError);
  });

  it("un owner/admin (propertyIds:null) acotado a una property concreta de ruta SOLO ve esa property en los claims, nunca todas", () => {
    const claims = buildTenantSessionClaims(membership({ propertyIds: null, platformRole: "owner" }), "hoteles", "prop-9");
    expect(claims.propertyIds).toEqual(["prop-9"]);
  });
});
