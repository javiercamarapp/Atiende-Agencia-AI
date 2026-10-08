// Una sola lista de colonias del piloto de PM (B02): integridad de los datos versionados del seed.
// Comprueba, sin base de datos: unicidad, sucursal de despacho mas cercana recalculada (Haversine) contra los pines de Google, regla de 8 km,
// que ninguna coordenada se invento, que lo PENDIENTE del dueño no se asigna, la coherencia con la cobertura que ya existe en la base real (169 filas)
// y la desviacion documentada de las coordenadas vigentes de las sucursales (que NO se cambian sin que el dueño confirme).
import { describe, expect, it } from "vitest";
import { assignBranch } from "../src/branch-assignment.ts";
import { normalizeZoneText } from "../src/nearest-branch.ts";
import { buildPmSeedPlan, renderPmSeedPlpgsql, type PmSeedColonia } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { matchKnownZone } from "../src/reglas-pedido.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const colonias = data.colonias as readonly PmSeedColonia[];
const plan = buildPmSeedPlan(data, agent);
const DESPACHO = ["T1", "T2", "T3", "T7", "T8"] as const;
const RADIO_KM = 8;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}
const pines = Object.fromEntries(data.sucursales.filter((b) => b.coordenadas_propuestas).map((b) => [b.id, { lat: b.coordenadas_propuestas!.lat, lng: b.coordenadas_propuestas!.lng }]));
const masCercana = (p: { lat: number; lng: number }) => DESPACHO.map((id) => ({ id, km: haversineKm(p, pines[id]!) })).sort((x, y) => x.km - y.km);

/** Homonimos (Google y OSM difieren mas de 1 km) que la regla de 8 km asigna con la coordenada elegida en colonias-v3 (decision de Javier, 8-oct): llevan `advertencia`. */
const HOMONIMOS_ASIGNADOS_POR_LA_REGLA = ["Arboledas", "Chuburná", "Dzitya", "Los Reyes", "San Angel", "San Jose", "San Luis", "Vergel", "Yucalpeten"];
/** Colonias que solo aparecen en los chats del dueño (sin fila en colonias-v3): sin coordenada, asignadas por esa evidencia. */
const SOLO_CHATS = ["Cabo Norte", "Los Pinos"];
/** Antes chocaban con el dueño/chats; Javier (8-oct) resolvio que manda la regla de 8 km (nombre -> [lo que decia el dueño, la mas cercana = la asignada]). */
const CONFLICTOS_RESUELTOS_POR_LA_REGLA: Readonly<Record<string, readonly [string, string]>> = {
  Centro: ["T1", "T3"],
  "Centro Histórico": ["T1", "T3"],
  "Benito Juárez Norte": ["T7", "T1"],
  "Real Montejo": ["T7", "T2"],
};

describe("lista unica de colonias (B02)", () => {
  it("186 colonias unicas: 184 de colonias-v3 + 2 de los chats; 185 entran a known_zone (Francisco de Montejo ES el punto de T2)", () => {
    const claves = new Set(colonias.map((c) => normalizeZoneText(c.nombre)));
    expect(colonias.length).toBe(186);
    expect(claves.size).toBe(186);
    expect(colonias.filter((c) => c.fuente === "chats_t7").map((c) => c.nombre).sort()).toEqual(SOLO_CHATS);
    expect(colonias.filter((c) => c.coordenada || c.mas_cercana).length + colonias.filter((c) => !c.coordenada && c.fuente === "piloto_original_merida_colonias").length).toBe(184);
    expect(plan.colonias.length).toBe(185);
    expect(plan.summary).toMatchObject({ coloniasAsignadas: 166, coloniasSinAsignar: 19, coloniasCubiertasPorDos: 0, coberturasColonias: 166, coloniasEnZonaDeSucursal: 1 });
    expect(data.colonias_meta).toMatchObject({ radio_reparto_km: RADIO_KM, conteos: { total: 186, asignadas: 167, pendientes_sin_asignar: 19, sin_coordenada: 8 } });
  });

  it("0 coordenadas inventadas: 178 con coordenada de Google (139), OSM (36) o promedio de ambas (3), 8 sin coordenada; ninguna se escribe en known_zone", () => {
    const con = colonias.filter((c) => c.coordenada);
    expect(con.length).toBe(178);
    expect(con.filter((c) => c.coordenada!.origen === "google").length).toBe(139);
    expect(con.filter((c) => c.coordenada!.origen === "osm").length).toBe(36);
    expect(con.filter((c) => c.coordenada!.origen === "promedio").length).toBe(3);
    const cerca = (a: { lat: number; lng: number } | null | undefined, b: { lat: number; lng: number }) => a != null && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
    for (const c of con) {
      const co = c.coordenada!;
      if (co.origen === "google") expect(cerca(c.google, co), c.nombre).toBe(true);
      else if (co.origen === "osm") expect(cerca(c.osm, co), c.nombre).toBe(true);
      else expect(cerca({ lat: (c.google!.lat + c.osm!.lat) / 2, lng: (c.google!.lng + c.osm!.lng) / 2 }, co), c.nombre).toBe(true);
      expect(["alta", "media", "baja"], c.nombre).toContain(co.confianza);
    }
    expect(colonias.filter((c) => !c.coordenada).length).toBe(8);
    // El plan (y por lo tanto el SQL) no lleva ninguna coordenada de colonia.
    expect(JSON.stringify(plan.colonias)).not.toMatch(/"lat"|"lng"/);
  });

  it("cada colonia asignada va a su sucursal de despacho MAS CERCANA, a 8 km o menos (recalculado con Haversine desde los pines de Google)", () => {
    let comprobadas = 0;
    for (const c of colonias.filter((x) => x.coordenada && (x.sucursales ?? []).length > 0)) {
      const [primera] = masCercana(c.coordenada!);
      expect(c.sucursales, c.nombre).toEqual([primera!.id]);
      expect(primera!.km, c.nombre).toBeLessThanOrEqual(RADIO_KM);
      expect(c.mas_cercana?.sucursal, c.nombre).toBe(primera!.id);
      expect(Math.abs((c.mas_cercana?.km ?? 99) - primera!.km), c.nombre).toBeLessThan(0.06);
      expect(c.sucursales!.every((id) => !["T4", "T5"].includes(id)), c.nombre).toBe(true);
      comprobadas++;
    }
    expect(comprobadas).toBe(165);
  });

  it("Centro, Centro Historico, Benito Juarez Norte y Real Montejo ya no son conflicto: la regla de 8 km manda (decision de Javier, 8-oct) y quedan en T3, T3, T1 y T2", () => {
    for (const [nombre, [delDueno, masCercana]] of Object.entries(CONFLICTOS_RESUELTOS_POR_LA_REGLA)) {
      const c = colonias.find((x) => x.nombre === nombre)!;
      expect(c.sucursales, nombre).toEqual([masCercana]);
      expect(c.asignacion, nombre).toBe("mas_cercana_v3");
      expect(c.pendiente_dueno, nombre).toBeUndefined();
      expect(c.mas_cercana?.sucursal, nombre).toBe(masCercana);
      expect(c.cobertura_base_real, nombre).toEqual([delDueno]);
      expect(c.advertencia, nombre).toMatch(/Resuelta por la regla de 8 km/);
    }
  });

  it("lo que queda SIN asignar es solo lo que la regla no puede asignar: fuera de 8 km (13) y sin coordenada (6); los homonimos (9) se asignan con la coordenada elegida", () => {
    const pendientes = colonias.filter((c) => (c.sucursales ?? []).length === 0);
    expect(pendientes.length).toBe(19);
    const porMotivo = (m: string) => pendientes.filter((c) => c.pendiente_dueno?.includes(m as never)).map((c) => c.nombre);
    expect(porMotivo("fuera_de_8km").length).toBe(13);
    expect(porMotivo("sin_coordenada").sort()).toEqual(["Cecilio Chi", "Nueva Salvador Alvarado Sur", "Olivos", "Revolución Cordemex", "San Diego Cutz", "Yucatán"].sort());
    expect(pendientes.filter((c) => c.pendiente_dueno?.includes("conflicto_regla_vs_dueno")).length).toBe(0);
    // Los motivos se recalculan: fuera de 8 km ⇔ la mas cercana esta a mas de 8 km.
    for (const c of colonias) {
      if (c.coordenada) {
        const [primera] = masCercana(c.coordenada);
        expect(!!c.pendiente_dueno?.includes("fuera_de_8km"), `${c.nombre} fuera_de_8km`).toBe(primera!.km > RADIO_KM);
        expect((c.sucursales ?? []).length === 0, `${c.nombre} sin asignar`).toBe(primera!.km > RADIO_KM);
      } else if (!SOLO_CHATS.includes(c.nombre)) {
        expect(c.pendiente_dueno, c.nombre).toContain("sin_coordenada");
      }
    }
    // Homonimos: se asignan por la regla y siguen marcados para revision del dueño.
    for (const nombre of HOMONIMOS_ASIGNADOS_POR_LA_REGLA) {
      const c = colonias.find((x) => x.nombre === nombre)!;
      expect(c.sucursales!.length, nombre).toBe(1);
      expect(c.revisar, nombre).toBe(true);
      expect(c.advertencia, nombre).toMatch(/Homónimo con discrepancia Google\/OSM/);
      expect(haversineKm(c.google!, c.osm!), nombre).toBeGreaterThan(1);
    }
    // En el plan ninguna pendiente recibe cobertura.
    for (const c of plan.colonias.filter((x) => pendientes.some((p) => p.nombre === x.name))) expect(c.branchIds, c.name).toEqual([]);
  });

  it("coherente con la base real (v1 + v2b = 169 filas de cobertura): el seed solo agrega a zonas sin cobertura; el SQL de colonias-8km reasigna las divergencias y estan documentadas", () => {
    // 166 filas en esta lista + 3 puntos de sucursal (T1, T7, T8) = 169.
    expect(colonias.reduce((n, c) => n + (c.cobertura_base_real?.length ?? 0), 0) + 3).toBe(169);
    const divergentes = colonias.filter((c) => (c.sucursales ?? []).length > 0 && (c.cobertura_base_real ?? []).length > 0 && !c.sucursales!.every((id) => c.cobertura_base_real!.includes(id)));
    expect(divergentes.map((c) => c.nombre).sort()).toEqual(["Andalucia", "Benito Juárez Norte", "Buenavista", "Caucel", "Centro", "Centro Histórico", "Guadalupe", "Paraiso Santa Fe", "Real Montejo", "Revolucion"].sort());
    for (const c of divergentes) expect(c.advertencia, c.nombre).toMatch(/Hoy la base real la cubre|Resuelta por la regla de 8 km/);
    const pendientesYaCubiertas = colonias.filter((c) => (c.sucursales ?? []).length === 0 && (c.cobertura_base_real ?? []).length > 0);
    expect(pendientesYaCubiertas.map((c) => c.nombre).sort()).toEqual(["Mulchechen", "Revolución Cordemex", "Salvador Alvarado Sur", "Santa Maria Chi", "Yucatán"].sort());
    for (const c of pendientesYaCubiertas) expect(c.advertencia, c.nombre).toMatch(/PENDIENTE del dueño/);
    // El resto (asignadas sin divergencia) cubre una sucursal que la base real ya tiene o no tiene cobertura todavia (se agrega).
    const nuevas = colonias.filter((c) => (c.sucursales ?? []).length > 0 && (c.cobertura_base_real ?? []).length === 0);
    expect(nuevas.length).toBe(20);
    const iguales = colonias.filter((c) => (c.sucursales ?? []).length > 0 && (c.cobertura_base_real ?? []).length > 0).length - divergentes.length;
    expect(iguales).toBe(137);
    // 167 asignadas (incluye Francisco de Montejo, que es el punto de T2, y Cabo Norte y Los Pinos del dueño).
    expect(divergentes.length + nuevas.length + iguales).toBe(167);
  });

  it("garantias de re-ejecucion sobre la cuenta real: el SQL no cambia el estado de sucursales existentes ni la procedencia de zonas con cobertura", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).not.toMatch(/update core\.property p set status/);
    // La unica actualizacion de known_zone con colonias es la de zonas que ACABAN de recibir su primera cobertura (CTE `nuevas`).
    const updates = sql.match(/update restaurantes\.known_zone z set [^\n]*/g) ?? [];
    expect(updates.some((u) => /set fuente =/.test(u))).toBe(false);
    expect(sql).toMatch(/with nuevas as \(/);
    expect(sql).toMatch(/from nuevas n, jsonb_to_recordset\(v->'colonias'\)/);
    expect(sql).toMatch(/z\.id = n\.zone_id/);
  });

  it("el SQL del seed inserta una fila de cobertura por colonia y sucursal (multicobertura) sin tocar coordenadas", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/jsonb_array_elements_text\(c\."branchIds"\)/);
    expect(sql).not.toMatch(/c\."branchId" from/);
    const payload = sql.slice(sql.indexOf("$pm$") + 4, sql.indexOf("$pm$", sql.indexOf("$pm$") + 4));
    const v = JSON.parse(payload) as { colonias: { name: string; branchIds: string[] }[] };
    expect(v.colonias.length).toBe(185);
    expect(v.colonias.filter((c) => c.branchIds.length === 1).length).toBe(166);
  });
});

describe("cobertura multiple (una colonia cubierta por dos sucursales)", () => {
  it("el plan y el mundo en memoria aceptan sucursales: [T1, T7] y crean una cobertura por sucursal", async () => {
    const doble = { nombre: "Colonia Doble", fuente: "piloto_original_merida_colonias" as const, sucursales: ["T1", "T7"], asignacion: "mas_cercana_v3" as const, referencia: null };
    const planDoble = buildPmSeedPlan({ ...data, colonias: [...colonias, doble] }, agent);
    expect(planDoble.summary).toMatchObject({ coloniasCubiertasPorDos: 1, coberturasColonias: 168 });
    const world = await buildInMemoryPmWorld(planDoble);
    const zona = matchKnownZone(await world.repo.listKnownZones(world.organizationId), "Colonia Doble")!;
    const cubren: string[] = [];
    for (const [slug, propertyId] of world.propertyBySlug) if ((await world.repo.listBranchDeliveryZoneIds(propertyId)).includes(zona.id)) cubren.push(slug);
    expect(cubren.sort()).toEqual(["garcia-lavin", "prol-montejo"]);
  });

  it("sigue aceptando el formato anterior (sucursal unica)", () => {
    const vieja = { nombre: "Colonia Vieja", fuente: "chats_t7" as const, sucursal: "T7", asignacion: "chats_t7" as const, referencia: null };
    expect(buildPmSeedPlan({ ...data, colonias: [...colonias, vieja] }, agent).colonias.find((c) => c.name === "Colonia Vieja")?.branchIds).toEqual(["T7"]);
  });
});

describe("coordenadas de las sucursales: propuestas de Google SEPARADAS de las vigentes (no se cambian sin confirmar)", () => {
  const vigentes = Object.fromEntries(data.sucursales.map((b) => [b.id, b.lat === null ? null : { lat: b.lat as number, lng: b.lng as number }]));

  it("las vigentes del seed siguen intactas y el plan no usa las propuestas", () => {
    expect(vigentes).toMatchObject({ T1: { lat: 21.028, lng: -89.61 }, T2: { lat: 21.035, lng: -89.605 }, T3: null, T7: { lat: 21.0205, lng: -89.615 }, T8: { lat: 21.0156, lng: -89.5982 } });
    expect(plan.zones.map((z) => [z.branchId, z.lat, z.lng])).toEqual(expect.arrayContaining([["T1", 21.028, -89.61], ["T7", 21.0205, -89.615]]));
    expect(JSON.stringify(plan.branches)).not.toContain("21.0093272");
  });

  it("documenta la desviacion: T1 2.1 km, T2 4.4 km, T7 1.9 km, T8 2.9 km; T3 no tiene coordenadas vigentes", () => {
    const km = (id: string) => haversineKm(vigentes[id]!, pines[id]!);
    expect(km("T1")).toBeCloseTo(2.11, 1);
    expect(km("T2")).toBeCloseTo(4.4, 1);
    expect(km("T7")).toBeCloseTo(1.85, 1);
    expect(km("T8")).toBeCloseTo(2.93, 1);
    for (const id of ["T1", "T2", "T7", "T8"]) expect(km(id), id).toBeGreaterThan(1.8);
    expect(vigentes.T3).toBeNull();
    expect(pines.T3).toEqual({ lat: 20.995212, lng: -89.6476676 });
  });

  it("T8: la direccion de la ficha de Google difiere de la del seed y queda PENDIENTE del dueño", () => {
    const t8 = data.sucursales.find((b) => b.id === "T8")!;
    expect(t8.coordenadas_propuestas?.pendiente_dueno).toMatch(/C\. 4 279.*Calle 7 No\. 270 local 20/);
    expect(t8.coordenadas_propuestas?.estado).toMatch(/PENDIENTE/);
    expect(data.pendientes_dueno.map((p) => p.id)).toEqual(expect.arrayContaining(["coordenadas_sucursales_google", "colonias_pendientes_dueno", "mapa_colonias", "coordenadas_t3"]));
  });
});

describe("carga DEMO: T2 y T8 se crean activas y el agente reconoce todas las colonias asignadas (assignBranch, no solo la cobertura)", () => {
  it("las 166 colonias asignadas devuelven estado 'asignada' con su sucursal; las 19 que quedan fuera de cobertura no se asignan", async () => {
    const planDemo = buildPmSeedPlan(data, agent, { demo: true });
    expect(planDemo.branches.filter((b) => b.status === "active").map((b) => b.slug).sort()).toEqual(["altabrisa", "fco-montejo", "garcia-lavin", "pensiones", "prol-montejo"]);
    // Sin demo siguen inactivas (cuenta normal) y el dato no cambia el plan normal.
    expect(plan.branches.filter((b) => b.status === "active").map((b) => b.slug).sort()).toEqual(["garcia-lavin", "pensiones", "prol-montejo"]);
    const world = await buildInMemoryPmWorld(planDemo);
    const slugDe = new Map(planDemo.branches.map((b) => [b.id, b.slug] as const));
    const noReconocidas: string[] = [];
    for (const c of planDemo.colonias) {
      const r = await assignBranch(world.repo, { organizationId: world.organizationId, colonia: c.name });
      if (c.branchIds.length > 0) {
        if (r.estado !== "asignada" || r.branchSlug !== slugDe.get(c.branchIds[0]!)) noReconocidas.push(`${c.name}: ${r.estado}`);
      } else {
        expect(r.estado, c.name).not.toBe("asignada");
      }
    }
    expect(noReconocidas).toEqual([]);
  });
});
