import { describe, expect, it } from "vitest";
import {
  FeatureNotAvailableError,
  canInviteStaff,
  hasAnyPlatformRole,
  hasFeature,
  hasPlatformRole,
  requireFeature,
} from "../src/index.ts";

describe("hasPlatformRole (jerarquía)", () => {
  it("owner alcanza cualquier techo", () => {
    expect(hasPlatformRole("owner", "admin")).toBe(true);
    expect(hasPlatformRole("owner", "viewer")).toBe(true);
  });

  it("viewer no alcanza member ni superior", () => {
    expect(hasPlatformRole("viewer", "member")).toBe(false);
    expect(hasPlatformRole("viewer", "admin")).toBe(false);
  });

  it("un rol alcanza exactamente su propio techo", () => {
    expect(hasPlatformRole("member", "member")).toBe(true);
  });
});

describe("hasAnyPlatformRole (lista explícita, no jerarquía)", () => {
  it("permite un subconjunto no contiguo, ej. auditor de solo lectura owner+viewer", () => {
    expect(hasAnyPlatformRole("viewer", ["owner", "viewer"])).toBe(true);
    expect(hasAnyPlatformRole("admin", ["owner", "viewer"])).toBe(false);
  });
});

describe("canInviteStaff (Fase 10 — quién puede invitar a quién)", () => {
  it("owner invita a cualquier rol, incluido otro owner", () => {
    expect(canInviteStaff("owner", "owner")).toBe(true);
    expect(canInviteStaff("owner", "admin")).toBe(true);
    expect(canInviteStaff("owner", "member")).toBe(true);
    expect(canInviteStaff("owner", "viewer")).toBe(true);
  });

  it("admin invita hasta su propio techo, nunca a un owner", () => {
    expect(canInviteStaff("admin", "admin")).toBe(true);
    expect(canInviteStaff("admin", "member")).toBe(true);
    expect(canInviteStaff("admin", "owner")).toBe(false);
  });

  it("member/viewer nunca invitan (no alcanzan 'admin' en la jerarquía)", () => {
    expect(canInviteStaff("member", "member")).toBe(false);
    expect(canInviteStaff("member", "viewer")).toBe(false);
    expect(canInviteStaff("viewer", "viewer")).toBe(false);
  });
});

describe("hasFeature / requireFeature", () => {
  it("feature presente en el set -> true", () => {
    expect(hasFeature(new Set(["voice", "cfdi"]), "voice")).toBe(true);
  });

  it("feature ausente del set -> false", () => {
    expect(hasFeature(new Set(["cfdi"]), "voice")).toBe(false);
  });

  it("set undefined/null (billing no resolvió nada) -> false, fail-closed, nunca true", () => {
    expect(hasFeature(undefined, "voice")).toBe(false);
    expect(hasFeature(null, "voice")).toBe(false);
  });

  it("requireFeature no lanza cuando la feature está disponible", () => {
    expect(() => requireFeature(new Set(["voice"]), "voice")).not.toThrow();
  });

  it("requireFeature lanza FeatureNotAvailableError (no un error de rol) cuando falta la feature", () => {
    try {
      requireFeature(new Set(["cfdi"]), "voice");
      expect.unreachable("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureNotAvailableError);
      expect((err as FeatureNotAvailableError).feature).toBe("voice");
      expect((err as FeatureNotAvailableError).code).toBe("feature_not_available");
    }
  });
});
