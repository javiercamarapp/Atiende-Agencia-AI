import { describe, expect, it } from "vitest";
import {
  FeatureNotAvailableError,
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
