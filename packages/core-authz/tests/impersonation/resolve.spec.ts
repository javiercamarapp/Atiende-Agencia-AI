import { describe, expect, it } from "vitest";
import {
  NoOrganizationSelectedError,
  resolveImpersonatedOrganization,
  signImpersonationSelection,
  type SuperadminActor,
} from "../../src/impersonation/index.ts";

const SECRET = "llave-dedicada-de-prueba-no-es-la-service-role-key";
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ACTOR: SuperadminActor = { userId: "superadmin-1", email: "javier@atiende.dev" };

describe("resolveImpersonatedOrganization", () => {
  it("con un explicitOrganizationId de la petición, lo devuelve con source 'explicit', ignorando cualquier cookie", () => {
    const cookie = signImpersonationSelection("org-de-la-cookie", SECRET, NOW);
    const resolved = resolveImpersonatedOrganization({
      actor: ACTOR,
      explicitOrganizationId: "org-explicita",
      cookieValue: cookie,
      secret: SECRET,
      nowMs: NOW,
    });
    expect(resolved).toEqual({ organizationId: "org-explicita", source: "explicit" });
  });

  it("sin explicit, con una cookie válida, devuelve la organización de la cookie con source 'cookie'", () => {
    const cookie = signImpersonationSelection("org-elegida", SECRET, NOW);
    const resolved = resolveImpersonatedOrganization({
      actor: ACTOR,
      cookieValue: cookie,
      secret: SECRET,
      nowMs: NOW,
    });
    expect(resolved).toEqual({ organizationId: "org-elegida", source: "cookie" });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // EL INCIDENTE REAL: un superadmin sin tenant/organización seleccionada
  // caía a "modo demo" EN SILENCIO. Esta suite reproduce EXACTAMENTE ese
  // escenario (ningún parámetro explícito, ninguna cookie) contra la
  // implementación real y confirma que se RECHAZA explícitamente — nunca
  // degrada a una organización por default.
  // ═══════════════════════════════════════════════════════════════════════
  describe("el incidente: superadmin SIN organización seleccionada", () => {
    it("sin explicit y sin cookie (petición nueva, nunca eligió nada) lanza NoOrganizationSelectedError — nunca devuelve una organización por default", () => {
      expect(() =>
        resolveImpersonatedOrganization({
          actor: ACTOR,
          cookieValue: undefined,
          secret: SECRET,
          nowMs: NOW,
        }),
      ).toThrow(NoOrganizationSelectedError);
    });

    it("el error trae el actorId de quien quedó sin resolver, para que el llamador lo loguee/rebote sin volver a parsear el mensaje", () => {
      try {
        resolveImpersonatedOrganization({ actor: ACTOR, cookieValue: null, secret: SECRET, nowMs: NOW });
        expect.unreachable("debía lanzar");
      } catch (err) {
        expect(err).toBeInstanceOf(NoOrganizationSelectedError);
        expect((err as NoOrganizationSelectedError).actorId).toBe("superadmin-1");
        expect((err as NoOrganizationSelectedError).code).toBe("no_organization_selected");
      }
    });

    it("con una cookie EXPIRADA (seleccionó ayer, ya venció) tampoco hay fallback — falla cerrado igual que sin cookie", () => {
      const cookie = signImpersonationSelection("org-vieja", SECRET, NOW - 13 * 60 * 60 * 1000);
      expect(() =>
        resolveImpersonatedOrganization({ actor: ACTOR, cookieValue: cookie, secret: SECRET, nowMs: NOW }),
      ).toThrow(NoOrganizationSelectedError);
    });

    it("con una cookie firmada con una llave YA ROTADA (secret no coincide) tampoco hay fallback", () => {
      const cookie = signImpersonationSelection("org-x", SECRET, NOW);
      expect(() =>
        resolveImpersonatedOrganization({
          actor: ACTOR,
          cookieValue: cookie,
          secret: "llave-nueva-tras-rotacion",
          nowMs: NOW,
        }),
      ).toThrow(NoOrganizationSelectedError);
    });

    it("sin llave de firma configurada en absoluto (env var ausente en producción) tampoco hay fallback silencioso", () => {
      const cookie = signImpersonationSelection("org-x", SECRET, NOW);
      expect(() =>
        resolveImpersonatedOrganization({ actor: ACTOR, cookieValue: cookie, secret: undefined, nowMs: NOW }),
      ).toThrow(NoOrganizationSelectedError);
    });

    it("una cookie con formato corrupto (edición manual, truncada) tampoco resuelve nada por default", () => {
      expect(() =>
        resolveImpersonatedOrganization({
          actor: ACTOR,
          cookieValue: "esto-no-es-una-cookie-firmada",
          secret: SECRET,
          nowMs: NOW,
        }),
      ).toThrow(NoOrganizationSelectedError);
    });

    it("un explicitOrganizationId como string vacío NO cuenta como selección explícita (cae al mismo fail-closed que 'nada')", () => {
      expect(() =>
        resolveImpersonatedOrganization({
          actor: ACTOR,
          explicitOrganizationId: "",
          cookieValue: undefined,
          secret: SECRET,
          nowMs: NOW,
        }),
      ).toThrow(NoOrganizationSelectedError);
    });
  });
});
