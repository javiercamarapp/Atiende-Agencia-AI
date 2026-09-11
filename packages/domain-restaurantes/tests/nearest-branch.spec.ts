// buscar_sucursal_cercana real (Fase 2 §1.1.1) — cubre el fix real de
// normalización (acentos/espacios/puntuación), el cálculo Haversine real, el
// aislamiento multi-tenant (misma colonia sembrada en dos organizaciones
// distintas nunca se cruza) y el contrato de silencio ante cero-match (nunca
// se inventa una sucursal).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findNearestBranch, haversineKm, normalizeZoneText } from "../src/nearest-branch.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";

describe("normalizeZoneText", () => {
  it("hace match entre 'Alta Brisa' y 'altabrisa' — bug real del 4-sep-2026", () => {
    expect(normalizeZoneText("Alta Brisa")).toBe(normalizeZoneText("altabrisa"));
  });

  it("quita acentos y puntuación de ambos lados", () => {
    expect(normalizeZoneText("Cholul, cerca de la Plaza")).toBe("cholulcercadelaplaza");
    expect(normalizeZoneText("Temozón Norte")).toBe("temozonnorte");
  });
});

describe("haversineKm", () => {
  it("la distancia de un punto a sí mismo es 0", () => {
    expect(haversineKm(21.0, -89.6, 21.0, -89.6)).toBe(0);
  });

  it("calcula una distancia real razonable entre dos puntos de Mérida", () => {
    const km = haversineKm(21.0186, -89.6708, 20.9814, -89.6923); // ~5km reales aprox.
    expect(km).toBeGreaterThan(3);
    expect(km).toBeLessThan(8);
  });
});

function seedTwoBranchOrg(repo: InMemoryRestaurantesRepository) {
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-nearest", name: "Org Nearest" });
  const near = randomUUID();
  const far = randomUUID();
  repo.seedBranch({ propertyId: near, organizationId, name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: 21.0619, lng: -89.6216 });
  repo.seedBranch({ propertyId: far, organizationId, name: "Chicxulub", slug: "chicxulub", status: "active", phone: null, address: null, lat: 21.2833, lng: -89.5333 });
  repo.seedKnownZone({ organizationId, name: "Altabrisa", lat: 21.0619, lng: -89.6216 }); // misma coordenada exacta que la sucursal "Altabrisa".
  repo.seedKnownZone({ organizationId, name: "Cholul", lat: 21.05, lng: -89.55 }); // más cerca de Altabrisa que de Chicxulub.
  return { organizationId, near, far };
}

describe("findNearestBranch — buscar_sucursal_cercana real", () => {
  it("una colonia reconocida (con variación de espacios/mayúsculas) devuelve la sucursal real más cercana calculada por distancia", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const { organizationId } = seedTwoBranchOrg(repo);

    const result = await findNearestBranch(repo, { organizationId, colonia: "  alta BRISA  " });

    expect(result).toEqual({ found: true, branchSlug: "altabrisa", branchName: "Altabrisa", distanceKm: 0, recognizedZoneName: "Altabrisa" });
  });

  it("una zona conocida distinta de la sucursal exacta calcula la sucursal real más cercana por Haversine, nunca 'a ojo'", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const { organizationId } = seedTwoBranchOrg(repo);

    const result = await findNearestBranch(repo, { organizationId, colonia: "Cholul" });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("unreachable");
    expect(result.branchSlug).toBe("altabrisa"); // Cholul está mucho más cerca de Altabrisa que de Chicxulub.
    expect(result.distanceKm).toBeGreaterThan(0);
  });

  it("CONTRATO DE SILENCIO: una colonia no reconocida nunca inventa/adivina una sucursal — found:false con el mensaje real", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const { organizationId } = seedTwoBranchOrg(repo);

    const result = await findNearestBranch(repo, { organizationId, colonia: "Guadalajara Centro" });

    expect(result).toEqual({ found: false, message: expect.stringContaining("No reconozco esa colonia") });
  });

  it("una colonia vacía/solo espacios se rechaza sin siquiera consultar el repositorio", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const { organizationId } = seedTwoBranchOrg(repo);

    const result = await findNearestBranch(repo, { organizationId, colonia: "   " });
    expect(result.found).toBe(false);
  });

  it("AISLAMIENTO MULTI-TENANT: la misma colonia sembrada en OTRA organización nunca hace match aquí", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const { organizationId: orgA } = seedTwoBranchOrg(repo);

    const orgB = randomUUID();
    repo.seedOrganization({ id: orgB, slug: "org-b", name: "Org B" });
    // orgB no tiene ninguna known_zone ni sucursal sembrada.

    const resultOrgA = await findNearestBranch(repo, { organizationId: orgA, colonia: "Altabrisa" });
    const resultOrgB = await findNearestBranch(repo, { organizationId: orgB, colonia: "Altabrisa" });

    expect(resultOrgA.found).toBe(true);
    expect(resultOrgB.found).toBe(false);
  });

  it("una sucursal INACTIVA nunca se devuelve como la más cercana, aunque su zona matchee exacto", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "org-inactiva", name: "Org" });
    const inactiveBranch = randomUUID();
    repo.seedBranch({ propertyId: inactiveBranch, organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: 21.0, lng: -89.6 });
    repo.seedKnownZone({ organizationId, name: "Centro", lat: 21.0, lng: -89.6 });

    const result = await findNearestBranch(repo, { organizationId, colonia: "Centro" });
    expect(result.found).toBe(false);
  });
});
