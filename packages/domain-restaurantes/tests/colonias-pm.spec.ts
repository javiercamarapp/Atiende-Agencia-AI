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
  it("carga ~180 colonias sin coordenadas (no se inventan) y reporta cuantas quedan sin asignar", () => {
    expect(plan.colonias.length).toBeGreaterThan(150);
    expect(plan.summary).toMatchObject({ colonias: plan.colonias.length });
    expect(plan.summary.coloniasAsignadas + plan.summary.coloniasSinAsignar).toBe(plan.colonias.length);
    expect(plan.summary.coloniasSinAsignar).toBeGreaterThan(0);
    expect(JSON.stringify(plan.colonias)).not.toMatch(/"lat"|"lng"/);
    expect(plan.colonias.every((c) => c.fuente === "piloto_original_merida_colonias" || c.fuente === "chats_t7")).toBe(true);
  });

  it("nunca asigna una colonia a Galerias (T4) ni a Playa (T5): no reparten", () => {
    expect(plan.colonias.filter((c) => c.branchId === "T4" || c.branchId === "T5")).toEqual([]);
  });

  it("las ambiguas (menos de 1 km entre las dos sucursales mas cercanas del piloto) quedan SIN asignar: no se adivina", () => {
    const ambiguas = (data.colonias ?? []).filter((c) => c.referencia?.alerta_ambigua && c.asignacion !== "chats_t7" && c.asignacion !== "direccion_sucursal" && c.asignacion !== "dueno_zona_centro");
    expect(ambiguas.length).toBeGreaterThan(20);
    for (const c of ambiguas) expect(c.sucursal, c.nombre).toBeNull();
  });

  it("el SQL del seed carga las colonias sin coordenadas y la cobertura solo a zonas sin cobertura previa (no pisa al dueño)", () => {
    const sql = renderPmSeedPlpgsql(plan);
    expect(sql).toMatch(/insert into restaurantes\.known_zone \(organization_id, name, lat, lng, fuente, asignacion_fuente/);
    expect(sql).toMatch(/not exists \(select 1 from restaurantes\.branch_delivery_zone bz where bz\.zone_id = z\.id\)/);
    expect(sql).toMatch(/z\.fuente in \('piloto_original_merida_colonias', 'chats_t7'\)/);
  });

  it("rechaza datos invalidos: sucursal que no reparte, nombre repetido, asignacion incoherente", () => {
    const con = (c: Partial<NonNullable<PmSeedData["colonias"]>[number]>[]): PmSeedData => ({ ...data, colonias: [...(data.colonias ?? []), ...c.map((x) => ({ nombre: "Colonia Nueva", fuente: "chats_t7" as const, sucursal: "T7", asignacion: "chats_t7" as const, referencia: null, ...x }))] });
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

  it("las 8 colonias que confirman los chats son de T7; Los Pinos de T8; Mexico de T1", async () => {
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

  it("'Centro' es de T1 (zona centro y norte del dueño) y gana el emparejamiento exacto sobre 'Centro Chichi Suarez'", async () => {
    const world = await buildInMemoryPmWorld(plan);
    expect(await sucursalQueCubre(world, "Centro")).toBe("prol-montejo");
    expect(await sucursalQueCubre(world, "centro")).toBe("prol-montejo");
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
    const ambigua = plan.colonias.find((c) => c.branchId === null && c.name === "Alcala Martin")!;
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
    // Una colonia ambigua no se adivina.
    expect(await assignBranch(world.repo, { organizationId: world.organizationId, colonia: "Alcala Martin" })).toMatchObject({ estado: "no_reconocida" });
  });
});
