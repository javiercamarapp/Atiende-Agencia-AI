// Paquete B: cobertura geografica (punto en poligono) con las geocercas de las sucursales. Los puntos de prueba son SINTETICOS (derivados de los
// vertices o muy lejos), no domicilios. Determinista, sin LLM.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assignBranch } from "../src/branch-assignment.ts";
import { geocercasQueContienen, puntoEnPoligono, type Geocerca } from "../src/geocercas.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { GEOCERCAS_PM } from "../src/seed/geocercas-pm.ts";

const CUADRO: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const U: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 0]];

describe("puntoEnPoligono", () => {
  it("dentro y fuera de un cuadrado", () => {
    expect(puntoEnPoligono(5, 5, CUADRO)).toBe(true);
    expect(puntoEnPoligono(11, 5, CUADRO)).toBe(false);
    expect(puntoEnPoligono(5, -0.1, CUADRO)).toBe(false);
  });
  it("poligono concavo: la muesca queda fuera", () => {
    expect(puntoEnPoligono(8, 5, U)).toBe(false);
    expect(puntoEnPoligono(8, 2, U)).toBe(true);
    expect(puntoEnPoligono(2, 5, U)).toBe(true);
  });
  it("entradas invalidas: false", () => {
    expect(puntoEnPoligono(Number.NaN, 1, CUADRO)).toBe(false);
    expect(puntoEnPoligono(1, 1, [[0, 0], [1, 1]])).toBe(false);
  });
});

// Centroide de vertices (lng, lat): un punto interior de referencia para cada geocerca real (todas son casi convexas); se verifica con el propio poligono.
function interior(g: Geocerca): readonly [number, number] {
  const v = g.poligono.slice(0, -1);
  // Busca un punto interior: punto medio entre el centroide y cada vertice hasta que caiga dentro.
  const cx = v.reduce((a, p) => a + p[0], 0) / v.length;
  const cy = v.reduce((a, p) => a + p[1], 0) / v.length;
  for (const p of v) {
    const m: readonly [number, number] = [(cx + p[0]) / 2, (cy + p[1]) / 2];
    if (puntoEnPoligono(m[1], m[0], g.poligono)) return m;
  }
  throw new Error("sin punto interior para " + g.slug);
}

describe("GEOCERCAS_PM (datos de Javier)", () => {
  it("trae las 5 sucursales que reparten, con anillos cerrados", () => {
    expect(GEOCERCAS_PM.map((g) => g.slug).sort()).toEqual(["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"]);
    for (const g of GEOCERCAS_PM) {
      expect(g.poligono.length).toBeGreaterThanOrEqual(4);
      expect(g.poligono[0]).toEqual(g.poligono[g.poligono.length - 1]);
    }
  });
  it.each(GEOCERCAS_PM.map((g) => g.slug))("un punto interior de %s esta dentro de su zona", (slug) => {
    const g = GEOCERCAS_PM.find((x) => x.slug === slug) as Geocerca;
    const [lng, lat] = interior(g);
    expect(geocercasQueContienen(lat, lng, GEOCERCAS_PM)).toContain(slug);
  });
  it("un punto en el golfo (muy lejos) no cae en ninguna", () => {
    expect(geocercasQueContienen(21.4, -89.9, GEOCERCAS_PM)).toEqual([]);
    expect(geocercasQueContienen(19.0, -98.0, GEOCERCAS_PM)).toEqual([]);
  });
  it("la zona de Altabrisa NO contiene el interior de la de Garcia Lavin (derivacion determinista)", () => {
    const t7 = GEOCERCAS_PM.find((g) => g.slug === "garcia-lavin") as Geocerca;
    const [lng, lat] = interior(t7);
    expect(geocercasQueContienen(lat, lng, GEOCERCAS_PM)).not.toContain("altabrisa");
  });
});

function mundo() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const ids: Record<string, string> = {};
  repo.seedOrganization({ id: organizationId, slug: "taqueria-ficticia", name: "Taquería Ficticia" });
  for (const [slug, name, phone] of [["garcia-lavin", "García Lavín", "999 000 0707"], ["altabrisa", "Altabrisa", "999 000 0808"]] as const) {
    ids[slug] = randomUUID();
    repo.seedBranch({ propertyId: ids[slug], organizationId, name, slug, status: "active", phone, address: null, lat: null, lng: null });
  }
  return { repo, organizationId, ids };
}

describe("assignBranch con geocercas (opt-in)", () => {
  const geo = GEOCERCAS_PM;
  const t7 = geo.find((g) => g.slug === "garcia-lavin") as Geocerca;
  const t8 = geo.find((g) => g.slug === "altabrisa") as Geocerca;

  it("pin dentro de la zona de T7: atiende T7", async () => {
    const { repo, organizationId } = mundo();
    const [lng, lat] = interior(t7);
    const r = await assignBranch(repo, { organizationId, lat, lng, geocercas: geo });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", origen: "pin" });
  });
  it("pin dentro de la zona de T8: deriva a Altabrisa con su telefono de configuracion", async () => {
    const { repo, organizationId } = mundo();
    const [lng, lat] = interior(t8);
    const r = await assignBranch(repo, { organizationId, lat, lng, geocercas: geo });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "altabrisa" });
    expect(r.message).toContain("999 000 0808");
  });
  it("pin fuera de toda zona: lo dice con honestidad, no promete envio y pasa al personal", async () => {
    const { repo, organizationId } = mundo();
    const r = await assignBranch(repo, { organizationId, lat: 21.4, lng: -89.9, geocercas: geo });
    expect(r.estado).toBe("no_reconocida");
    expect(r.message).toMatch(/ninguna zona/i);
    expect(r.message).toMatch(/escalar_a_humano/);
    expect(r.message).toMatch(/recoger/i);
  });
  it("pin en la zona de una sucursal que no reparte / no existe en la base: no se asigna a otra", async () => {
    const { repo, organizationId } = mundo();
    const pensiones = GEOCERCAS_PM.find((g) => g.slug === "pensiones") as Geocerca;
    const [lng, lat] = interior(pensiones);
    const r = await assignBranch(repo, { organizationId, lat, lng, geocercas: geo.filter((g) => g.slug === "pensiones") });
    expect(r.estado).toBe("no_reconocida");
  });
  it("sin geocercas el comportamiento no cambia (pin lejano sigue su camino de siempre)", async () => {
    const { repo, organizationId } = mundo();
    const r = await assignBranch(repo, { organizationId, lat: 21.4, lng: -89.9 });
    expect(r.estado).not.toBe("asignada");
  });
  it("con zonas traslapadas manda la sucursal de entrada si es una de las que contienen el punto", async () => {
    const { repo, organizationId, ids } = mundo();
    const a: Geocerca = { slug: "garcia-lavin", poligono: CUADRO };
    const b: Geocerca = { slug: "altabrisa", poligono: CUADRO };
    const r = await assignBranch(repo, { organizationId, lat: 5, lng: 5, geocercas: [a, b], sucursalDeEntregaPreferidaPropertyId: ids["altabrisa"] });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "altabrisa" });
    const r2 = await assignBranch(repo, { organizationId, lat: 5, lng: 5, geocercas: [a, b] });
    expect(r2).toMatchObject({ estado: "asignada", branchSlug: "altabrisa" }); // empate sin entrada: orden estable por slug
  });
});
