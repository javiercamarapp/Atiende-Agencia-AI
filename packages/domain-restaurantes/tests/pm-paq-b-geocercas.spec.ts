// Paquete B: cobertura geografica con las geocercas REALES (las 5 zonas de reparto de PM) y el camino enlazado (assignBranch y la herramienta buscar_sucursal_cercana).
// Los puntos de prueba son SINTETICOS (vertices, bordes, rendijas y puntos interiores calculados de los propios poligonos); ningun domicilio. Sin LLM.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { assignBranch } from "../src/branch-assignment.ts";
import { COORDENADAS_PROPUESTAS_PM } from "../src/coordenadas-sucursales.ts";
import { GEOCERCA_AVISO_DERIVAR, GEOCERCA_COLONIA_SIN_PIN_MENSAJE, GEOCERCA_SIN_ZONA_MENSAJE, GEOCERCA_TOLERANCIA_M, distanciaAPoligonoM, geocercasActivas, geocercasCercanas, geocercasQueContienen, puntoEnPoligono, type Geocerca } from "../src/geocercas.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { haversineKmExact } from "../src/nearest-branch.ts";
import { GEOCERCAS_PM } from "../src/seed/geocercas-pm.ts";
import type { AgentToolContext } from "../src/agent-tools/registry.ts";

const zona = (slug: string): Geocerca => GEOCERCAS_PM.find((g) => g.slug === slug) as Geocerca;
const SLUGS = ["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"] as const;
const CUADRO: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const U: readonly (readonly [number, number])[] = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 0]];

/** Punto interior de un poligono: el medio entre el centroide de vertices y un vertice, el primero que cae dentro. */
function interior(g: Geocerca): { lat: number; lng: number } {
  const v = g.poligono.slice(0, -1);
  const cx = v.reduce((a, p) => a + p[0], 0) / v.length;
  const cy = v.reduce((a, p) => a + p[1], 0) / v.length;
  for (const p of v) {
    const lng = (cx + p[0]) / 2;
    const lat = (cy + p[1]) / 2;
    if (puntoEnPoligono(lat, lng, g.poligono)) return { lat, lng };
  }
  throw new Error("sin punto interior para " + g.slug);
}
/** Mueve un vertice `m` metros alejandose del centroide (queda fuera en vertices convexos). */
function fueraDeVertice(g: Geocerca, indice: number, m: number): { lat: number; lng: number } {
  const v = g.poligono.slice(0, -1);
  const cx = v.reduce((a, p) => a + p[0], 0) / v.length;
  const cy = v.reduce((a, p) => a + p[1], 0) / v.length;
  const [x, y] = v[indice] as readonly [number, number];
  const dx = x - cx;
  const dy = y - cy;
  const n = Math.hypot(dx, dy);
  return { lat: y + ((dy / n) * m) / 111_320, lng: x + ((dx / n) * m) / (111_320 * Math.cos((y * Math.PI) / 180)) };
}

describe("puntoEnPoligono y distancia", () => {
  it("cuadrado y poligono concavo (muesca)", () => {
    expect(puntoEnPoligono(5, 5, CUADRO)).toBe(true);
    expect(puntoEnPoligono(11, 5, CUADRO)).toBe(false);
    expect(puntoEnPoligono(8, 5, U)).toBe(false);
    expect(puntoEnPoligono(8, 2, U)).toBe(true);
    expect(puntoEnPoligono(Number.NaN, 1, CUADRO)).toBe(false);
  });
  it("distancia 0 dentro y en el borde; positiva fuera", () => {
    expect(distanciaAPoligonoM(5, 5, CUADRO)).toBe(0);
    expect(distanciaAPoligonoM(21.0, -89.6, [[-89.601, 20.999], [-89.599, 20.999], [-89.599, 21.001], [-89.601, 21.001], [-89.601, 20.999]])).toBe(0);
    expect(distanciaAPoligonoM(21.0, -89.598, [[-89.601, 20.999], [-89.599, 20.999], [-89.599, 21.001], [-89.601, 21.001], [-89.601, 20.999]])).toBeGreaterThan(90);
  });
});

describe("GEOCERCAS_PM (KMZ del dueño): geometria", () => {
  it("5 zonas con anillo cerrado", () => {
    expect(GEOCERCAS_PM.map((g) => g.slug).sort()).toEqual([...SLUGS]);
    for (const g of GEOCERCAS_PM) expect(g.poligono[0]).toEqual(g.poligono[g.poligono.length - 1]);
  });
  it.each(SLUGS)("interior de %s: cae en su zona", (slug) => {
    const p = interior(zona(slug));
    expect(geocercasQueContienen(p.lat, p.lng, GEOCERCAS_PM)).toContain(slug);
  });
  it.each(SLUGS)("un vertice de %s esta a ~0 m de su borde (en el borde)", (slug) => {
    const v = zona(slug).poligono[2] as readonly [number, number];
    expect(distanciaAPoligonoM(v[1], v[0], zona(slug).poligono)).toBeLessThan(0.5);
    expect(geocercasCercanas(v[1], v[0], GEOCERCAS_PM).map((c) => c.slug)).toContain(slug);
  });
  it.each(SLUGS)("justo fuera de %s (300 m mas alla de un vertice): no pertenece a su zona", (slug) => {
    const g = zona(slug);
    // Busca un vertice convexo cuyo punto exterior a 300 m quede fuera de ESTA zona.
    const fuera = g.poligono.slice(0, -1).map((_, i) => fueraDeVertice(g, i, 300)).find((p) => distanciaAPoligonoM(p.lat, p.lng, g.poligono) > GEOCERCA_TOLERANCIA_M);
    expect(fuera).toBeDefined();
    const p = fuera as { lat: number; lng: number };
    expect(geocercasCercanas(p.lat, p.lng, [g]).map((c) => c.slug)).not.toContain(slug);
  });
  it("T8 no contiene interiores de T7 y T7 no contiene interiores de T8", () => {
    for (const [a, b] of [["garcia-lavin", "altabrisa"], ["altabrisa", "garcia-lavin"]] as const) {
      const g = zona(a);
      let n = 0;
      for (const v of g.poligono.slice(0, -1)) {
        const cx = g.poligono.slice(0, -1).reduce((s, p) => s + p[0], 0) / (g.poligono.length - 1);
        const cy = g.poligono.slice(0, -1).reduce((s, p) => s + p[1], 0) / (g.poligono.length - 1);
        for (const f of [0.3, 0.6]) {
          const lng = cx + (v[0] - cx) * f;
          const lat = cy + (v[1] - cy) * f;
          if (puntoEnPoligono(lat, lng, g.poligono)) {
            n += 1;
            expect(puntoEnPoligono(lat, lng, zona(b).poligono)).toBe(false);
          }
        }
      }
      expect(n).toBeGreaterThan(5);
    }
  });
  it("fuera de toda zona (golfo / otro estado): ninguna", () => {
    expect(geocercasCercanas(21.4, -89.9, GEOCERCAS_PM)).toEqual([]);
    expect(geocercasCercanas(19.0, -98.0, GEOCERCAS_PM)).toEqual([]);
  });
});

function mundo(opts: { inactivas?: readonly string[]; sinTelefono?: readonly string[] } = {}) {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  const ids: Record<string, string> = {};
  repo.seedOrganization({ id: organizationId, slug: "taqueria-ficticia", name: "Taquería Ficticia" });
  SLUGS.forEach((slug, i) => {
    ids[slug] = randomUUID();
    repo.seedBranch({
      propertyId: ids[slug] as string,
      organizationId,
      name: `Sucursal ${slug}`,
      slug,
      status: opts.inactivas?.includes(slug) ? "inactive" : "active",
      phone: opts.sinTelefono?.includes(slug) ? null : `999 000 0${i}0${i}`,
      address: null,
      lat: null,
      lng: null,
    });
  });
  return { repo, organizationId, ids, tel: (slug: string): string => `999 000 0${SLUGS.indexOf(slug as (typeof SLUGS)[number])}0${SLUGS.indexOf(slug as (typeof SLUGS)[number])}` };
}

describe("assignBranch con geocercas", () => {
  it("pin dentro de T7: atiende T7, sin km ni 'aproximada' (la cobertura la dicta el poligono)", async () => {
    const { repo, organizationId } = mundo();
    const p = interior(zona("garcia-lavin"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", origen: "cobertura_dueno", via: "coordenadas", distanceKm: null, aproximada: false });
  });
  it("pin dentro de T8 con chat de T7: deriva a Altabrisa con su telefono de configuracion y el aviso de horario", async () => {
    const { repo, organizationId, ids, tel } = mundo();
    const p = interior(zona("altabrisa"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM, sucursalDeEntregaPreferidaPropertyId: ids["garcia-lavin"] });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: "altabrisa" });
    expect(r.message).toContain(tel("altabrisa"));
    expect(r.message).toContain(GEOCERCA_AVISO_DERIVAR.trim());
  });
  it("sin telefono cargado en la sucursal derivada: no lo inventa", async () => {
    const { repo, organizationId, ids } = mundo({ sinTelefono: ["altabrisa"] });
    const p = interior(zona("altabrisa"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM, sucursalDeEntregaPreferidaPropertyId: ids["garcia-lavin"] });
    expect(r.message).toMatch(/no lo invente/i);
    expect(r.message).not.toMatch(/\d{3}\s?\d{3}\s?\d{4}/);
  });
  it("sin derivar (el chat es de la sucursal que atiende) no agrega el aviso de horario", async () => {
    const { repo, organizationId, ids } = mundo();
    const p = interior(zona("garcia-lavin"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM, sucursalDeEntregaPreferidaPropertyId: ids["garcia-lavin"] });
    expect(r.message).not.toContain(GEOCERCA_AVISO_DERIVAR.trim());
  });
  it("pin fuera de toda zona: lo dice honestamente, no promete envio, ofrece recoger y pasa al personal", async () => {
    const { repo, organizationId } = mundo();
    const r = await assignBranch(repo, { organizationId, lat: 21.4, lng: -89.9, geocercas: GEOCERCAS_PM });
    expect(r).toEqual({ estado: "no_reconocida", message: GEOCERCA_SIN_ZONA_MENSAJE });
    expect(r.message).toMatch(/escalar_a_humano/);
    expect(r.message).toMatch(/recoger/i);
  });
  it("pin en la zona de una sucursal INACTIVA: NO dice 'ninguna zona'; nombra la sucursal, da su telefono y ofrece recoger", async () => {
    const { repo, organizationId, tel } = mundo({ inactivas: ["altabrisa"] });
    const p = interior(zona("altabrisa"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM });
    expect(r.estado).toBe("no_reconocida");
    expect(r.message).not.toMatch(/ninguna zona/i);
    expect(r.message).toContain("Sucursal altabrisa");
    expect(r.message).toContain(tel("altabrisa"));
    expect(r.message).toMatch(/recoger/i);
  });
  it("pin en la zona de una sucursal que no esta cargada en la base: tampoco dice 'ninguna zona'", async () => {
    const { repo, organizationId } = mundo();
    const p = interior(zona("pensiones"));
    const r = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: [zona("pensiones")].map((g) => ({ ...g, slug: "no-existe" })) });
    expect(r.message).not.toMatch(/ninguna zona/i);
    expect(r.message).toContain("no-existe");
  });

  it("zona con traslape real T1/T7: la sucursal por la que entro el cliente; sin entrada, la de pin mas cercano", async () => {
    const { repo, organizationId, ids } = mundo();
    // Punto sintetico dentro de ambas zonas (traslape real del dibujo; verificado abajo).
    const doble: { lat: number; lng: number } | null = { lat: 21.0274, lng: -89.6248 };
    const p = doble as { lat: number; lng: number };
    const contienen = geocercasQueContienen(p.lat, p.lng, GEOCERCAS_PM);
    expect([...contienen].sort()).toEqual(["garcia-lavin", "prol-montejo"]);
    const km = (s: string): number => haversineKmExact(p.lat, p.lng, COORDENADAS_PROPUESTAS_PM[s]!.lat, COORDENADAS_PROPUESTAS_PM[s]!.lng);
    const masCercana = km("garcia-lavin") < km("prol-montejo") ? "garcia-lavin" : "prol-montejo";
    const sin = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM });
    expect(sin).toMatchObject({ estado: "asignada", branchSlug: masCercana, dobleCobertura: true });
    const otra = masCercana === "garcia-lavin" ? "prol-montejo" : "garcia-lavin";
    const con = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: GEOCERCAS_PM, sucursalDeEntregaPreferidaPropertyId: ids[otra] });
    expect(con).toMatchObject({ estado: "asignada", branchSlug: otra });
  });
  it.each([
    ["T1/T2", 20.9972, -89.6279, ["fco-montejo", "prol-montejo"]],
    ["T1/T7", 21.0194, -89.6174, ["garcia-lavin", "prol-montejo"]],
    ["T7/T8", 21.0257, -89.5949, ["altabrisa", "garcia-lavin"]],
  ] as const)("rendija entre zonas %s: ninguna la contiene, ambas estan a <= %d m y gana la de pin mas cercano", async (_n, lat, lng, esperadas) => {
    const { repo, organizationId } = mundo();
    expect(geocercasQueContienen(lat, lng, GEOCERCAS_PM)).toEqual([]);
    const cerca = geocercasCercanas(lat, lng, GEOCERCAS_PM).map((c) => c.slug);
    for (const e of esperadas) expect(cerca).toContain(e);
    const candidatas = cerca.filter((s) => esperadas.includes(s as never));
    const km = (s: string): number => haversineKmExact(lat, lng, COORDENADAS_PROPUESTAS_PM[s]!.lat, COORDENADAS_PROPUESTAS_PM[s]!.lng);
    const esperada = [...cerca].sort((a, b) => km(a) - km(b) || a.localeCompare(b))[0];
    expect(candidatas.length).toBeGreaterThan(1);
    const r = await assignBranch(repo, { organizationId, lat, lng, geocercas: GEOCERCAS_PM });
    expect(r).toMatchObject({ estado: "asignada", branchSlug: esperada });
    // Determinista: repetir da lo mismo.
    expect(await assignBranch(repo, { organizationId, lat, lng, geocercas: GEOCERCAS_PM })).toEqual(r);
  });
  it("a mas de la holgura de toda zona (300 m fuera de un vertice de T7) no se asigna", async () => {
    const { repo, organizationId } = mundo();
    const g = zona("garcia-lavin");
    const p = g.poligono.slice(0, -1).map((_, i) => fueraDeVertice(g, i, 300)).find((q) => geocercasCercanas(q.lat, q.lng, GEOCERCAS_PM).length === 0);
    expect(p).toBeDefined();
    const r = await assignBranch(repo, { organizationId, lat: (p as { lat: number }).lat, lng: (p as { lng: number }).lng, geocercas: GEOCERCAS_PM });
    expect(r.estado).toBe("no_reconocida");
  });

  it("colonia CON coordenadas dentro de T8 y SIN pin: NO afirma cobertura (ni por el centroide ni por el radio); pide el pin", async () => {
    const { repo, organizationId } = mundo();
    const p = interior(zona("altabrisa"));
    repo.seedKnownZone({ id: randomUUID(), organizationId, name: "Residencial Ficticia Altamira", lat: p.lat, lng: p.lng });
    const r = await assignBranch(repo, { organizationId, colonia: "Residencial Ficticia Altamira", geocercas: GEOCERCAS_PM });
    expect(r).toEqual({ estado: "no_reconocida", message: GEOCERCA_COLONIA_SIN_PIN_MENSAJE });
  });
  it("nombre de colonia desconocido y SIN pin (p. ej. un fraccionamiento de Altabrisa o Country Towers): NO inventa cobertura; pide el pin y, si no, la sucursal confirma y escala", async () => {
    const { repo, organizationId } = mundo();
    for (const colonia of ["Country Towers", "Altabrisa", "Fraccionamiento Ficticio Norte"]) {
      const r = await assignBranch(repo, { organizationId, colonia, geocercas: GEOCERCAS_PM });
      expect(r).toEqual({ estado: "no_reconocida", message: GEOCERCA_COLONIA_SIN_PIN_MENSAJE });
    }
    expect(GEOCERCA_COLONIA_SIN_PIN_MENSAJE).toMatch(/no afirme ni niegue/i);
    expect(GEOCERCA_COLONIA_SIN_PIN_MENSAJE).toMatch(/la sucursal le confirma/i);
    expect(GEOCERCA_COLONIA_SIN_PIN_MENSAJE).toMatch(/escalar_a_humano/);
  });
  it("SIN geocercas el resultado completo es identico al de siempre (mensaje sin telefono ni aviso)", async () => {
    const { repo, organizationId } = mundo();
    const p = interior(zona("altabrisa"));
    const base = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng });
    const conVacio = await assignBranch(repo, { organizationId, lat: p.lat, lng: p.lng, geocercas: [] });
    expect(conVacio).toEqual(base);
    expect(base.message).not.toMatch(/\d{3} \d{3} \d{4}/);
    expect(base.message).not.toContain("Teléfono de");
    expect(base.message).not.toContain(GEOCERCA_AVISO_DERIVAR.trim());
    const sinPin = await assignBranch(repo, { organizationId, colonia: "Country Towers" });
    expect(sinPin).toMatchObject({ estado: "no_reconocida" });
    expect((sinPin as { message: string }).message).not.toBe(GEOCERCA_COLONIA_SIN_PIN_MENSAJE);
  });
});

describe("buscar_sucursal_cercana (camino enlazado del agente)", () => {
  afterEach(() => vi.unstubAllEnvs());
  async function agente() {
    const w = mundo();
    await w.repo.upsertWhatsAppAgentConfig(w.organizationId, null, { perfil: "taqueria_pm", agentName: "Lupe", businessName: null, toneStyle: null, deliveryTimeText: null } as never);
    const ctx = (extra: Partial<AgentToolContext>): AgentToolContext => ({ organizationId: w.organizationId, channel: "whatsapp", phone: "+5219991234567", ...extra });
    return { ...w, ctx };
  }
  const llamar = async (a: Awaited<ReturnType<typeof agente>>, extra: Partial<AgentToolContext>, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    (await invokeAgentTool(a.repo, a.ctx(extra), "buscar_sucursal_cercana", input)).result as Record<string, unknown>;

  it("la bandera esta apagada por omision", () => {
    expect(geocercasActivas({})).toBe(false);
    expect(geocercasActivas({ RESTAURANTES_GEOCERCAS: "1" })).toBe(true);
  });
  it("encendida: pin en T8 desde el chat de T7 => Altabrisa, con telefono (atiende_otra_sucursal), aviso de horario y sin prometer entrega desde T7", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const a = await agente();
    const p = interior(zona("altabrisa"));
    const r = await llamar(a, { entryPropertyId: a.ids["garcia-lavin"], sharedLocation: p });
    expect(r).toMatchObject({ encontrada: true, branch_slug: "altabrisa", origen_asignacion: "cobertura_dueno" });
    expect(r["atiende_otra_sucursal"]).toMatchObject({ telefono: a.tel("altabrisa") });
    expect(String(r["mensaje"])).toContain(a.tel("altabrisa"));
    expect(String(r["mensaje"])).toContain(GEOCERCA_AVISO_DERIVAR.trim());
  });
  it("encendida: pin fuera de toda zona => no encontrada, mensaje honesto, ni sucursal ni distancia", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const a = await agente();
    const r = await llamar(a, { entryPropertyId: a.ids["garcia-lavin"], sharedLocation: { lat: 21.4, lng: -89.9 } });
    expect(r).toMatchObject({ encontrada: false, estado: "no_reconocida", mensaje: GEOCERCA_SIN_ZONA_MENSAJE });
    expect(r["branch_slug"]).toBeUndefined();
  });
  it("encendida: colonia por nombre sin pin => no afirma cobertura, pide el pin o escalar", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const a = await agente();
    const r = await llamar(a, { entryPropertyId: a.ids["garcia-lavin"] }, { colonia: "Country Towers" });
    expect(r).toMatchObject({ encontrada: false, mensaje: GEOCERCA_COLONIA_SIN_PIN_MENSAJE });
  });
  it("apagada (por omision): el mismo pin NO usa geocercas y el resultado no trae su marca", async () => {
    const a = await agente();
    const p = interior(zona("altabrisa"));
    const r = await llamar(a, { entryPropertyId: a.ids["garcia-lavin"], sharedLocation: p });
    expect(String(r["mensaje"] ?? "")).not.toContain(GEOCERCA_AVISO_DERIVAR.trim());
    expect(r["origen_asignacion"]).not.toBe("cobertura_dueno");
  });
  it("organizacion que no es PM: ignora la bandera", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const w = mundo();
    const p = interior(zona("altabrisa"));
    const r = (await invokeAgentTool(w.repo, { organizationId: w.organizationId, channel: "whatsapp", phone: "+5219991234567", sharedLocation: p }, "buscar_sucursal_cercana", {})).result as Record<string, unknown>;
    expect(String(r["mensaje"] ?? "")).not.toContain(GEOCERCA_AVISO_DERIVAR.trim());
  });
});
