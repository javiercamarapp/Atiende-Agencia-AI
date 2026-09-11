import { describe, expect, it } from "vitest";
import {
  IMPERSONATION_TTL_MS,
  ImpersonationSigningKeyMissingError,
  InvalidOrganizationIdError,
  signImpersonationSelection,
  verifyImpersonationSelection,
} from "../../src/impersonation/index.ts";

const SECRET = "llave-dedicada-de-prueba-no-es-la-service-role-key";
const OTHER_SECRET = "otra-llave-completamente-distinta";
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

describe("signImpersonationSelection / verifyImpersonationSelection", () => {
  it("round-trip: lo que se firma se valida y devuelve la misma organizationId", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    const selection = verifyImpersonationSelection(cookie, SECRET, NOW);
    expect(selection).toEqual({ organizationId: "org-123", expiresAtMs: NOW + IMPERSONATION_TTL_MS });
  });

  it("el TTL es de 12 horas exactas", () => {
    expect(IMPERSONATION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("justo en el borde de expiración (ahora === expira) todavía es válida", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    const selection = verifyImpersonationSelection(cookie, SECRET, NOW + IMPERSONATION_TTL_MS);
    expect(selection?.organizationId).toBe("org-123");
  });

  it("un milisegundo después de expirar, ya no es válida", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    const selection = verifyImpersonationSelection(cookie, SECRET, NOW + IMPERSONATION_TTL_MS + 1);
    expect(selection).toBeNull();
  });

  it("una firma alterada (tamper) se rechaza", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    const tampered = cookie.slice(0, -4) + "AAAA";
    expect(verifyImpersonationSelection(tampered, SECRET, NOW)).toBeNull();
  });

  it("cambiar la organización sin volver a firmar invalida la firma", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    const parts = cookie.split(".");
    const forged = ["v1", "org-OTRA-DISTINTA", parts[2], parts[3]].join(".");
    expect(verifyImpersonationSelection(forged, SECRET, NOW)).toBeNull();
  });

  it("una cookie firmada con una llave se rechaza si se valida con otra (rotación de llave)", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    expect(verifyImpersonationSelection(cookie, OTHER_SECRET, NOW)).toBeNull();
  });

  it("valores malformados (formato, prefijo de versión, campos vacíos) se rechazan como null, nunca lanzan", () => {
    expect(verifyImpersonationSelection("no-es-una-cookie-valida", SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection("v2.org-123.999.firma", SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection("v1.org-123.no-es-numero.firma", SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection("v1..999.firma", SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection("", SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection(undefined, SECRET, NOW)).toBeNull();
    expect(verifyImpersonationSelection(null, SECRET, NOW)).toBeNull();
  });

  it("firmar sin llave (ausente o vacía) falla CERRADO lanzando, nunca produce una cookie sin firma real", () => {
    expect(() => signImpersonationSelection("org-123", undefined, NOW)).toThrow(ImpersonationSigningKeyMissingError);
    expect(() => signImpersonationSelection("org-123", "", NOW)).toThrow(ImpersonationSigningKeyMissingError);
    expect(() => signImpersonationSelection("org-123", "   ", NOW)).toThrow(ImpersonationSigningKeyMissingError);
  });

  it("firmar sin organizationId lanza — no tiene sentido una selección vacía", () => {
    expect(() => signImpersonationSelection("", SECRET, NOW)).toThrow(InvalidOrganizationIdError);
  });

  it("validar sin llave (ausente o vacía) devuelve null, nunca lanza ni acepta la cookie a ciegas", () => {
    const cookie = signImpersonationSelection("org-123", SECRET, NOW);
    expect(verifyImpersonationSelection(cookie, undefined, NOW)).toBeNull();
    expect(verifyImpersonationSelection(cookie, "", NOW)).toBeNull();
  });
});
