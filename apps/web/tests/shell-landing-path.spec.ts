import { describe, expect, it } from "vitest";
import { decideLandingPathForInvite, decideOrganizacionSeleccionadaPath } from "../src/lib/auth-client.ts";
import type { LoginSession, OrganizationSummary } from "../src/lib/auth-client.ts";

// Hallazgo de auditoría (severidad ALTA, "2 puntos de entrada restantes con el bug
// de landing-path para repartidor/staff invitado"): AceptarInvitacion.tsx y
// SeleccionarOrganizacion.tsx son los otros 2 lugares (además de `decideLandingPath`,
// ya cubierto en auth-client.spec.ts) que deciden a dónde navega un usuario después
// de autenticarse — y ambos navegaban siempre al Dashboard de KPIs
// (`/<vertical>/<slug>`, protegido por MANAGER_ROLES) sin mirar el `rol` de la
// organización, así que un repartidor invitado terminaba en un 403 en vez de en su
// panel real `/restaurantes/:slug/repartidor` (ver Repartidor.tsx).

function org(overrides: Partial<OrganizationSummary> = {}): OrganizationSummary {
  return { id: "1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "owner", ...overrides };
}

describe("decideLandingPathForInvite (AceptarInvitacion.tsx)", () => {
  const base: LoginSession = { token: "t", refreshToken: "r", email: "invitado@x.mx", organizations: [] };

  it("sin organizaciones -> /sin-organizacion", () => {
    expect(decideLandingPathForInvite(base)).toBe("/sin-organizacion");
  });

  it("con exactamente una organización y rol de gestión -> entra directo a su slug", () => {
    const session = { ...base, organizations: [org({ rol: "owner" })] };
    expect(decideLandingPathForInvite(session)).toBe("/restaurantes/los-taquitos-de-pm");
  });

  it("con exactamente una organización y rol repartidor -> entra directo a su panel, no al Dashboard (403)", () => {
    const session = { ...base, organizations: [org({ rol: "repartidor" })] };
    expect(decideLandingPathForInvite(session)).toBe("/restaurantes/los-taquitos-de-pm/repartidor");
  });

  it("usa el `vertical` real de la organización, no un hardcode de restaurantes", () => {
    const session = { ...base, organizations: [org({ vertical: "hoteles", rol: "owner" })] };
    expect(decideLandingPathForInvite(session)).toBe("/hoteles/los-taquitos-de-pm");
  });

  it("con 2+ organizaciones -> selector, sin importar el rol", () => {
    const session = { ...base, organizations: [org({ id: "1", slug: "a" }), org({ id: "2", slug: "b", rol: "repartidor" })] };
    expect(decideLandingPathForInvite(session)).toBe("/seleccionar-organizacion");
  });
});

describe("decideOrganizacionSeleccionadaPath (SeleccionarOrganizacion.tsx)", () => {
  it("organización con rol de gestión -> navega al Dashboard de esa organización", () => {
    expect(decideOrganizacionSeleccionadaPath("restaurantes", org({ rol: "owner" }))).toBe("/restaurantes/los-taquitos-de-pm");
  });

  it("organización con rol repartidor -> navega directo a su panel, no al Dashboard (403)", () => {
    expect(decideOrganizacionSeleccionadaPath("restaurantes", org({ rol: "repartidor" }))).toBe("/restaurantes/los-taquitos-de-pm/repartidor");
  });
});
