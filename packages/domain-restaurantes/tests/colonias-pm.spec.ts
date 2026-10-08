// Colonias del piloto original en el seed de PM: la sucursal que las cubre, el comportamiento del agente con ellas y la integridad de los datos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignBranch } from "../src/branch-assignment.ts";
import { OrderValidationError } from "../src/errors.ts";
import { quoteOrder } from "../src/orders.ts";
import { matchKnownZone } from "../src/reglas-pedido.ts";
import { buildPmSeedPlan, PmSeedError, renderPmSeedPlpgsql, type PmSeedData } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);

/** Slug de la sucursal que cubre la colonia dicha tal como la entiende el agente (mismo emparejamiento que la regla de zona). */
async function sucursalQueCubre(world: Awaited<ReturnType<typeof buildInMemoryPmWorld>>, colonia: string): Promise<string | null> {
  const zona = matchKnownZone(await world.repo.listKnownZones(world.organizationId), colonia);
  if (!zona) return null;
  for (const [slug, propertyId] of world.propertyBySlug) {
    if ((await world.repo.listBranchDeliveryZoneIds(propertyId)).includes(zona.id)) return slug;
  }
  return "(ninguna)";
}

describe("colonias del piloto en el plan del seed", () => {
  it("carga la lista unica de colonias sin coordenadas en known_zone (no se inventan) y reporta cuantas quedan sin asignar", () => {
    // 186 en los datos: Francisco de Montejo ES el punto de T2 (ya existe como zona) y no se duplica.
    expect(plan.colonias.length).toBe(185);
    expect(plan.summary.coloniasEnZonaDeSucursal).toBe(1);
    expect(plan.summary).toMatchObject({ colonias: plan.colonias.length });
    expect(plan.summary.coloniasAsignadas + plan.summary.coloniasSinAsignar).toBe(plan.colonias.length);
    expect(plan.summary.coloniasSinAsignar).toBeGreaterThan(0);
    expect(JSON.stringify(plan.colonias)).not.toMatch(/"lat"|"lng"/);
    expect(plan.colonias.every((c) => c.fuente === "piloto_original_merida_colonias" || c.fuente === "chats_t7")).toBe(true);
  });

  it("nunca asigna una colonia a Galerias (T4) ni a Playa (T5): no reparten", () => {
    expect(plan.colonias.filter((c) => c.branchIds.includes("T4") || c.branchIds.includes("T5"))).toEqual([]);
  });

  it("lo que queda SIN asignar es exactamente lo PENDIENTE del dueño (fuera de 8 km, homonimo con discrepancia, sin coordenada): una ambigua de menos de 1 km ya no se deja sin asignar, va a la mas cercana", () => {
    const sinAsignar = (data.colonias ?? []).filter((c) => (c.sucursales ?? []).length === 0);
    expect(sinAsignar.length).toBe(28);
    for (const c of sinAsignar) {
      expect(c.asignacion, c.nombre).toBe("sin_asignar");
      expect(c.pendiente_dueno?.length, c.nombre).toBeGreaterThan(0);
      expect(c.motivo_sin_asignar, c.nombre).toBe(c.pendiente_dueno?.[0]);
    }
    // Alcala Martin: T1 a 2.12 km y T3 a 2.92 km (ambigua para el piloto, 0.2 km de diferencia con su ficha): decide la regla de Javier.
    expect((data.colonias ?? []).find((c) => c.nombre === "Alcala Martin")).toMatchObject({ sucursales: ["T1"], asignacion: "mas_cercana_v3" });
  });

  it("el SQL del seed carga las colonias sin coordenadas y la cobertura solo a zonas sin cobertura previa (no pisa al dueño)", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.known_zone \(organization_id, name, lat, lng, fuente, asignacion_fuente/);
    expect(sql).toMatch(/not exists \(select 1 from restaurantes\.branch_delivery_zone bz where bz\.zone_id = z\.id\)/);
    expect(sql).toMatch(/z\.fuente in \('piloto_original_merida_colonias', 'chats_t7'\)/);
  });

  it("rechaza datos invalidos: sucursal que no reparte, nombre repetido, asignacion incoherente, coordenada inventada", () => {
    const con = (c: Partial<NonNullable<PmSeedData["colonias"]>[number]>[]): PmSeedData => ({ ...data, colonias: [...(data.colonias ?? []), ...c.map((x) => ({ nombre: "Colonia Nueva", fuente: "chats_t7" as const, sucursal: "T7", asignacion: "chats_t7" as const, referencia: null, ...x }))] });
    expect(() => buildPmSeedPlan(con([{ sucursal: undefined, sucursales: ["T7", "T7"] }]), agent)).toThrow(/repetida/);
    expect(() => buildPmSeedPlan(con([{ sucursal: undefined, sucursales: ["T7", "T5"] }]), agent)).toThrow(/no reparte/);
    const lat = 21.02;
    expect(() => buildPmSeedPlan(con([{ coordenada: { lat, lng: -89.6, origen: "google", confianza: "alta" }, google: null, osm: null }]), agent)).toThrow(/inventadas/);
    expect(() => buildPmSeedPlan(con([{ coordenada: { lat: 40, lng: -89.6, origen: "osm", confianza: "alta" }, osm: { lat: 40, lng: -89.6 } }]), agent)).toThrow(/fuera de Yucatan/);
    expect(() => buildPmSeedPlan(con([{ pendiente_dueno: ["inventado" as never] }]), agent)).toThrow(/pendiente_dueno invalido/);
    expect(() => buildPmSeedPlan(con([{ sucursal: "T4" }]), agent)).toThrow(PmSeedError);
    expect(() => buildPmSeedPlan(con([{}, {}]), agent)).toThrow(/duplicada/);
    expect(() => buildPmSeedPlan(con([{ sucursal: null }]), agent)).toThrow(/sin_asignar/);
    expect(() => buildPmSeedPlan(con([{ nombre: "xy" }]), agent)).toThrow(/al menos 4/);
  });
});

describe("agente de PM con las colonias cargadas (mundo en memoria del seed)", () => {
  // Reloj fijo a mediodía de Mérida: la cotización exige sucursal abierta y el resultado no debe depender de la hora de la corrida.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T13:00:00-06:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("las 8 colonias que confirman los chats son de T7 (incluidas Benito Juarez Norte y Real Montejo, que la regla de la mas cercana mandaria a T1 y T2: conflicto marcado para Javier); Los Pinos de T8; Mexico de T1", async () => {
    const world = await buildInMemoryPmWorld(plan);
    for (const colonia of ["Temozón Norte", "Montebello", "Benito Juárez Norte", "Montes de Amé", "San Ramón Norte", "Sodzil Norte", "Cabo Norte", "Real Montejo"]) {
      expect(await sucursalQueCubre(world, colonia), colonia).toBe("garcia-lavin");
    }
    expect(await sucursalQueCubre(world, "Los Pinos")).toBe("altabrisa");
    expect(await sucursalQueCubre(world, "México")).toBe("prol-montejo");
  });

  it("'Alta Brisa', 'Casa Altabrisa' y 'Plaza Alta Brisa' caen en T8 (regresion X41: un espacio de mas no cambia la sucursal)", async () => {
    const world = await buildInMemoryPmWorld(plan);
    for (const colonia of ["Alta Brisa", "Casa Altabrisa", "Plaza Alta Brisa", "Victory Altabrisa"]) expect(await sucursalQueCubre(world, colonia), colonia).toBe("altabrisa");
  });

  it("'Centro' es de T1 (zona centro y norte del dueño; la mas cercana seria T3: conflicto marcado) y gana el emparejamiento exacto sobre 'Centro Chichi Suarez' (T8)", async () => {
    const world = await buildInMemoryPmWorld(plan);
    expect(await sucursalQueCubre(world, "Centro")).toBe("prol-montejo");
    expect(await sucursalQueCubre(world, "centro")).toBe("prol-montejo");
    expect(await sucursalQueCubre(world, "Centro Histórico")).toBe("prol-montejo");
    expect(await sucursalQueCubre(world, "Centro Chichi Suarez")).toBe("altabrisa");
  });

  it("cotizar a domicilio desde T7: una colonia de T7 pasa; una de otra zona se rechaza como fuera de zona", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const base = { organizationId: world.organizationId, branchSlug: "garcia-lavin", canal: "domicilio" as const, items: [{ productId: world.productIds.get("Coca-Cola")!, requestedQuantity: 6 }] };
    expect((await quoteOrder(world.repo, { ...base, colonia: "Temozón Norte" })).total).toBeGreaterThan(0);
    const fuera = await quoteOrder(world.repo, { ...base, colonia: "Los Pinos" }).catch((e: unknown) => e);
    expect(fuera).toBeInstanceOf(OrderValidationError);
    expect((fuera as Error).message).toMatch(/fuera de la zona de reparto de García Lavín/);
  });

  it("una colonia conocida SIN sucursal asignada (ambigua) no se rechaza como 'fuera de zona': se manda a una persona", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const ambigua = plan.colonias.find((c) => c.branchIds.length === 0 && c.name === "Chicxulub")!;
    expect(ambigua).toBeDefined();
    const base = { organizationId: world.organizationId, branchSlug: "garcia-lavin", canal: "domicilio" as const, items: [{ productId: world.productIds.get("Coca-Cola")!, requestedQuantity: 6 }] };
    const error = await quoteOrder(world.repo, { ...base, colonia: ambigua.name }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderValidationError);
    expect((error as Error).message).toMatch(/todavía no tiene una sucursal de reparto asignada/);
    expect((error as Error).message).toMatch(/pase el pedido con una persona/);
  });

  it("buscar_sucursal_cercana: una colonia asignada a una sucursal ACTIVA devuelve esa sucursal sin inventar distancia", async () => {
    const world = await buildInMemoryPmWorld(plan);
    expect(await assignBranch(world.repo, { organizationId: world.organizationId, colonia: "Temozón Norte" })).toMatchObject({ estado: "asignada", branchSlug: "garcia-lavin", distanceKm: null });
    // Una colonia PENDIENTE del dueño (Chicxulub: a 29 km de la sucursal de despacho mas cercana) no se adivina ni se declara «no reconocida» (import-orig-01):
    // es una colonia cargada, sin ubicacion cierta -> `sugerida` por confirmar (pide el pin o pasa a una persona).
    expect(await assignBranch(world.repo, { organizationId: world.organizationId, colonia: "Chicxulub" })).toMatchObject({ estado: "sugerida", reparto: "por_confirmar" });
    // Con la regla de la mas cercana, Alcala Martin (antes ambigua) va a T1.
    expect(await sucursalQueCubre(world, "Alcala Martin")).toBe("prol-montejo");
  });
});
