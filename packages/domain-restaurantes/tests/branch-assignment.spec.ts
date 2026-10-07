// R-02 -- asignacion de sucursal por cercania en km (Haversine) con zonas conocidas como ajuste.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignBranch, RADIO_MAXIMO_REPARTO_KM, rankBranchesByKm } from "../src/branch-assignment.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { OrderValidationError } from "../src/errors.ts";
import type { Branch } from "../src/types.ts";

// Coordenadas aproximadas de las sucursales de PM (pm-datos.json, "repo, sin confirmar").
const SUCURSALES = [
  { slug: "prol-montejo", name: "Prolongación Montejo", lat: 21.028, lng: -89.61 },
  { slug: "fco-montejo", name: "Francisco de Montejo", lat: 21.035, lng: -89.605 },
  { slug: "garcia-lavin", name: "Victory Platz", lat: 21.0205, lng: -89.615 },
  { slug: "altabrisa", name: "Victory Altabrisa", lat: 21.0156, lng: -89.5982 },
] as const;

function seed() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "pm", name: "PM" });
  const ids: Record<string, string> = {};
  for (const s of SUCURSALES) {
    ids[s.slug] = randomUUID();
    repo.seedBranch({ propertyId: ids[s.slug]!, organizationId, name: s.name, slug: s.slug, status: "active", phone: null, address: null, lat: s.lat, lng: s.lng });
  }
  return { repo, organizationId, ids };
}

describe("assignBranch -- coordenadas", () => {
  it("asigna la sucursal mas cercana en km al punto de entrega", async () => {
    const { repo, organizationId } = seed();
    const r = await assignBranch(repo, { organizationId, lat: 21.0165, lng: -89.596 });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "altabrisa", via: "coordenadas", recognizedZoneName: null, ajustePorZona: false });
  });

  it("un punto exactamente sobre una sucursal da 0 km", async () => {
    const { repo, organizationId } = seed();
    const r = await assignBranch(repo, { organizationId, lat: 21.0205, lng: -89.615 });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", distanceKm: 0 });
  });

  it("un empate exacto de distancia se rompe por slug (resultado determinista)", () => {
    const mk = (slug: string, lng: number): Branch => ({ propertyId: slug, organizationId: "o", name: slug, slug, status: "active", phone: null, address: null, lat: 0, lng });
    const ranked = rankBranchesByKm(0, 0, [mk("zeta", 1), mk("alfa", -1)]);
    expect(ranked.map((r) => r.branch.slug)).toEqual(["alfa", "zeta"]);
  });

  it("ordena por distancia sin redondear: dos sucursales a 0.04 km de diferencia no empatan", () => {
    const mk = (slug: string, lat: number): Branch => ({ propertyId: slug, organizationId: "o", name: slug, slug, status: "active", phone: null, address: null, lat, lng: 0 });
    // 0.1 km ~ 0.0009 grados; ambas redondean a 0.1 km pero una es mas cercana.
    const ranked = rankBranchesByKm(0, 0, [mk("a-lejos", 0.0009), mk("b-cerca", 0.00055)]);
    expect(ranked[0]!.branch.slug).toBe("b-cerca");
  });

  it("ignora sucursales inactivas y sin coordenadas; sin ninguna utilizable => no_reconocida", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    repo.seedBranch({ propertyId: randomUUID(), organizationId, name: "T4 pendiente", slug: "t4", status: "active", phone: null, address: null, lat: null, lng: null });
    repo.seedBranch({ propertyId: randomUUID(), organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: 21.0, lng: -89.6 });
    const r = await assignBranch(repo, { organizationId, lat: 21.0, lng: -89.6 });
    expect(r.estado).toBe("no_reconocida");
  });

  it("no cruza organizaciones: sucursales de otra organizacion nunca se asignan", async () => {
    const { repo } = seed();
    const r = await assignBranch(repo, { organizationId: randomUUID(), lat: 21.0165, lng: -89.596 });
    expect(r.estado).toBe("no_reconocida");
  });

  it.each([
    ["lat fuera de rango", { lat: 91, lng: 0 }],
    ["lng fuera de rango", { lat: 0, lng: -181 }],
    ["NaN", { lat: Number.NaN, lng: 0 }],
    ["Infinity", { lat: 0, lng: Number.POSITIVE_INFINITY }],
    ["solo lat", { lat: 21 }],
    ["solo lng", { lng: -89 }],
  ])("rechaza coordenadas invalidas (%s) con error de validacion", async (_n, coords) => {
    const { repo, organizationId } = seed();
    await expect(assignBranch(repo, { organizationId, ...coords })).rejects.toBeInstanceOf(OrderValidationError);
  });

  it("los polos y la fecha internacional no rompen el calculo", async () => {
    const { repo, organizationId } = seed();
    for (const [lat, lng] of [[90, 0], [-90, 180], [0, -180]] as const) {
      const r = await assignBranch(repo, { organizationId, lat, lng });
      // Los polos quedan a miles de km: con el tope duro de reparto son `fuera_de_zona`, pero el calculo no se rompe (distancia finita).
      expect(["asignada", "fuera_de_zona"]).toContain(r.estado);
      if (r.estado === "asignada" || r.estado === "fuera_de_zona") expect(Number.isFinite(r.distanceKm)).toBe(true);
    }
  });

  it("QA-PM-R2-whatsapp-08: un pin a 28.8 km (Progreso) es fuera_de_zona aunque el modelo mande max_km 500 o nada", async () => {
    const { repo, organizationId } = seed();
    const progreso = { lat: 21.2817, lng: -89.665 };
    for (const maxKm of [undefined, 500, 100]) {
      const r = await assignBranch(repo, { organizationId, ...progreso, ...(maxKm === undefined ? {} : { maxKm }) });
      expect(r.estado).toBe("fuera_de_zona");
      if (r.estado === "fuera_de_zona") expect(r.maxKm).toBe(RADIO_MAXIMO_REPARTO_KM);
    }
  });

  it("el modelo puede BAJAR el radio pero no subirlo", async () => {
    const { repo, organizationId } = seed();
    const punto = { lat: 21.0156, lng: -89.5882 };
    expect((await assignBranch(repo, { organizationId, ...punto, maxKm: 0.5 })).estado).toBe("fuera_de_zona");
    expect((await assignBranch(repo, { organizationId, ...punto })).estado).toBe("asignada");
  });
});

describe("assignBranch -- radio maximo (fuera de zona)", () => {
  it("exactamente en el limite aun se asigna; apenas mas lejos es fuera_de_zona", async () => {
    const { repo, organizationId } = seed();
    const punto = { lat: 21.0156, lng: -89.5882 }; // ~1.04 km al este de Altabrisa
    const base = await assignBranch(repo, { organizationId, ...punto });
    expect(base.estado).toBe("asignada");
    const exacto = base.estado === "asignada" ? (base.distanceKm ?? 0) : 0;
    // maxKm mayor que la distancia real: asigna.
    expect(await assignBranch(repo, { organizationId, ...punto, maxKm: exacto + 0.5 })).toMatchObject({ estado: "asignada" });
    // maxKm menor que la distancia real: fuera de zona, con la sucursal mas cercana informada.
    const fuera = await assignBranch(repo, { organizationId, ...punto, maxKm: exacto - 0.5 });
    expect(fuera).toMatchObject({ estado: "fuera_de_zona", branchSlug: "altabrisa" });
  });

  it("un punto en otra ciudad con radio de 10 km es fuera_de_zona (nunca se asigna en silencio)", async () => {
    const { repo, organizationId } = seed();
    const r = await assignBranch(repo, { organizationId, lat: 20.9674, lng: -89.5926, maxKm: 10 }); // otro punto, ~6 km: dentro
    expect(r.estado).toBe("asignada");
    const lejos = await assignBranch(repo, { organizationId, lat: 19.4326, lng: -99.1332, maxKm: 10 }); // CDMX
    expect(lejos.estado).toBe("fuera_de_zona");
  });

  it.each([0, -1, Number.NaN, 501])("maxKm invalido (%s) es error de validacion", async (maxKm) => {
    const { repo, organizationId } = seed();
    await expect(assignBranch(repo, { organizationId, lat: 21, lng: -89.6, maxKm })).rejects.toBeInstanceOf(OrderValidationError);
  });
});

describe("assignBranch -- zonas conocidas", () => {
  it("una colonia reconocida sin cobertura configurada se resuelve por km puros desde la zona", async () => {
    const { repo, organizationId } = seed();
    repo.seedKnownZone({ organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    const r = await assignBranch(repo, { organizationId, colonia: "vista  alegre" });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "altabrisa", via: "zona", recognizedZoneName: "Vista Alegre", ajustePorZona: false });
  });

  it("la cobertura explicita de la zona AJUSTA la sucursal aunque otra quede mas cerca en km", async () => {
    const { repo, organizationId, ids } = seed();
    repo.seedKnownZone({ organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    const zone = (await repo.listKnownZones(organizationId))[0]!;
    // El cliente asigna Vista Alegre a Prolongacion Montejo (zona fija), aunque Altabrisa quede a ~0.1 km.
    repo.seedBranchDeliveryZones(ids["prol-montejo"]!, [zone.id]);
    const r = await assignBranch(repo, { organizationId, colonia: "Vista Alegre" });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "prol-montejo", ajustePorZona: true });
  });

  it("con varias sucursales cubriendo la zona gana la mas cercana entre ellas", async () => {
    const { repo, organizationId, ids } = seed();
    repo.seedKnownZone({ organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    const zone = (await repo.listKnownZones(organizationId))[0]!;
    repo.seedBranchDeliveryZones(ids["prol-montejo"]!, [zone.id]);
    repo.seedBranchDeliveryZones(ids["fco-montejo"]!, [zone.id]);
    const r = await assignBranch(repo, { organizationId, colonia: "Vista Alegre" });
    expect(r).toMatchObject({ branchSlug: "prol-montejo", ajustePorZona: true });
  });

  it("si la sucursal que cubre la zona no tiene coordenadas, cae a km puros (no se queda sin sucursal)", async () => {
    const { repo, organizationId } = seed();
    const sinCoords = randomUUID();
    repo.seedBranch({ propertyId: sinCoords, organizationId, name: "Pensiones", slug: "pensiones", status: "active", phone: null, address: null, lat: null, lng: null });
    repo.seedKnownZone({ organizationId, name: "San Damian", lat: 20.98, lng: -89.65 });
    const zone = (await repo.listKnownZones(organizationId))[0]!;
    repo.seedBranchDeliveryZones(sinCoords, [zone.id]);
    const r = await assignBranch(repo, { organizationId, colonia: "San Damián" });
    expect(r.estado).toBe("asignada");
    if (r.estado === "asignada") expect(r.branchSlug).not.toBe("pensiones");
  });

  it("coordenadas + colonia: las coordenadas fijan el punto, la zona solo ajusta", async () => {
    const { repo, organizationId, ids } = seed();
    repo.seedKnownZone({ organizationId, name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    const zone = (await repo.listKnownZones(organizationId))[0]!;
    repo.seedBranchDeliveryZones(ids["fco-montejo"]!, [zone.id]);
    const r = await assignBranch(repo, { organizationId, lat: 21.0156, lng: -89.5982, colonia: "Vista Alegre" });
    expect(r).toMatchObject({ branchSlug: "fco-montejo", via: "coordenadas", recognizedZoneName: "Vista Alegre", ajustePorZona: true });
  });

  it("colonia desconocida sin coordenadas => no_reconocida, nunca adivina", async () => {
    const { repo, organizationId } = seed();
    expect(await assignBranch(repo, { organizationId, colonia: "Colonia inventada" })).toMatchObject({ estado: "no_reconocida" });
    expect(await assignBranch(repo, { organizationId, colonia: "   " })).toMatchObject({ estado: "no_reconocida" });
    expect(await assignBranch(repo, { organizationId })).toMatchObject({ estado: "no_reconocida" });
  });

  it("zonas de otra organizacion no se usan", async () => {
    const { repo, organizationId } = seed();
    repo.seedKnownZone({ organizationId: randomUUID(), name: "Vista Alegre", lat: 21.0152, lng: -89.5995 });
    expect(await assignBranch(repo, { organizationId, colonia: "Vista Alegre" })).toMatchObject({ estado: "no_reconocida" });
  });
});

describe("colonia reconocida SIN coordenadas (migracion 056, colonias del piloto original)", () => {
  async function mundoColonias() {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    const t1 = randomUUID();
    const t7 = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
    repo.seedBranch({ propertyId: t1, organizationId, name: "Prolongación Montejo", slug: "prol-montejo", status: "active", phone: null, address: null, lat: 21.028, lng: -89.61 });
    repo.seedBranch({ propertyId: t7, organizationId, name: "García Lavín", slug: "garcia-lavin", status: "active", phone: null, address: null, lat: 21.0205, lng: -89.615 });
    const temozon = randomUUID();
    const ambigua = randomUUID();
    repo.seedKnownZone({ id: temozon, organizationId, name: "Temozón Norte", lat: null, lng: null });
    repo.seedKnownZone({ id: ambigua, organizationId, name: "Alcalá Martín", lat: null, lng: null });
    repo.seedBranchDeliveryZones(t7, [temozon]);
    return { repo, organizationId, t1, t7, temozon, ambigua };
  }

  it("la sucursal sale de la cobertura cargada; sin distancia inventada", async () => {
    const { repo, organizationId } = await mundoColonias();
    expect(await assignBranch(repo, { organizationId, colonia: "temozon norte" })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", distanceKm: null, via: "zona", recognizedZoneName: "Temozón Norte" });
  });

  it("colonia sin ninguna sucursal que la cubra (ambigua): no se adivina, no_reconocida", async () => {
    const { repo, organizationId } = await mundoColonias();
    expect(await assignBranch(repo, { organizationId, colonia: "Alcalá Martín" })).toMatchObject({ estado: "no_reconocida" });
  });

  it("cubierta por dos sucursales: no se elige por orden de listado", async () => {
    const { repo, organizationId, t1, temozon } = await mundoColonias();
    repo.seedBranchDeliveryZones(t1, [temozon]);
    expect(await assignBranch(repo, { organizationId, colonia: "Temozón Norte" })).toMatchObject({ estado: "no_reconocida" });
  });

  it("con pin: el punto es el pin (via coordenadas) y la cobertura de la colonia sigue ganando sobre la geometria pura", async () => {
    const { repo, organizationId } = await mundoColonias();
    expect(await assignBranch(repo, { organizationId, lat: 21.0281, lng: -89.6101 })).toMatchObject({ estado: "asignada", branchSlug: "prol-montejo", via: "coordenadas" });
    expect(await assignBranch(repo, { organizationId, colonia: "Temozón Norte", lat: 21.0281, lng: -89.6101 })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", via: "coordenadas", ajustePorZona: true });
  });

  it("findNearestBranch (buscar por colonia) ignora la colonia sin coordenadas: silencio, nunca una sucursal inventada", async () => {
    const { repo, organizationId } = await mundoColonias();
    expect(await repo.findNearestBranchByColonia(organizationId, "Temozón Norte")).toBeNull();
  });
});
