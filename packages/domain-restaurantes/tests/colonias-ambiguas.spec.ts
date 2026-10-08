// X42: reporte de colonias ambiguas sobre los datos del piloto original (sin coordenadas) y compatibilidad con la base sin migrar.
import { describe, expect, it } from "vitest";
import { reporteColoniasAmbiguas } from "../src/colonias-ambiguas.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { buildPmSeedPlan } from "../src/seed/pm-demo.ts";
import { buildInMemoryPmWorld } from "../src/seed/pm-world.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const { data, agent } = loadSeedInputs();
const plan = buildPmSeedPlan(data, agent);

describe("reporte de colonias ambiguas con los datos del piloto", () => {
  it("lista las colonias cargadas con sucursal asignada, km, segunda sucursal y la marca 'revisar'", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const r = await reporteColoniasAmbiguas(world.repo, world.organizationId);
    expect(r.disponible).toBe(true);
    // 183 colonias del piloto + los 4 puntos de sucursal con coordenadas (distancia calculada).
    expect(r.total).toBe(plan.colonias.length + 4);
    expect(r.sinAsignar).toBe(plan.summary.coloniasSinAsignar);
    expect(r.ambiguas).toBeGreaterThanOrEqual(plan.summary.coloniasSinAsignar - 5);
    const temozon = r.filas.find((f) => f.colonia === "Temozón Norte")!;
    expect(temozon).toMatchObject({ sucursalAsignada: { slug: "garcia-lavin" }, origenKm: "piloto_original", revisar: true });
    expect(temozon.motivos).toContain("ambigua");
    expect(temozon.diferenciaKm).toBeLessThan(1);
  });

  it("una colonia sin sucursal asignada se marca 'sin_asignar'; una clara y asignada no se marca", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const r = await reporteColoniasAmbiguas(world.repo, world.organizationId);
    const sin = r.filas.find((f) => f.colonia === "Arboledas")!;
    expect(sin.sucursalAsignada).toBeNull();
    expect(sin.motivos).toContain("sin_asignar");
    const clara = plan.colonias.find((c) => c.branchIds.includes("T8") && c.asignacionFuente === "mas_cercana_v3" && (c.refKm ?? 0) > 0 && c.ref2Km! - c.refKm! >= 1 && c.refSlug === "altabrisa" && c.ref2Slug !== "pensiones")!;
    const fila = r.filas.find((f) => f.colonia === clara.name)!;
    expect(fila.motivos).not.toContain("ambigua");
    expect(fila.motivos).not.toContain("sin_asignar");
  });

  it("la asignacion de los chats que contradice la distancia del piloto se marca 'contradice_distancia' (Montebello: piloto Altabrisa, chats T7)", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const r = await reporteColoniasAmbiguas(world.repo, world.organizationId);
    const montebello = r.filas.find((f) => f.colonia === "Montebello")!;
    expect(montebello.sucursalAsignada?.slug).toBe("garcia-lavin");
    expect(montebello.motivos).toContain("contradice_distancia");
    expect(montebello.revisar).toBe(true);
  });

  it("las reasignadas desde Galerias y las distancias a Pensiones llevan su motivo", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const r = await reporteColoniasAmbiguas(world.repo, world.organizationId);
    expect(r.filas.filter((f) => f.motivos.includes("reasignada_desde_galerias")).length).toBe(plan.colonias.filter((c) => c.asignacionFuente === "reasignada_desde_galerias").length);
    expect(r.filas.some((f) => f.motivos.includes("distancia_de_otra_direccion_de_pensiones"))).toBe(true);
  });

  it("el reporte no trae datos personales ni coordenadas inventadas de las colonias", async () => {
    const world = await buildInMemoryPmWorld(plan);
    const r = await reporteColoniasAmbiguas(world.repo, world.organizationId);
    expect(JSON.stringify(r)).not.toMatch(/@|\+52|customer|phone|telefono/i);
    expect(r.filas.filter((f) => f.origenKm === "piloto_original").every((f) => !("lat" in f) && !("lng" in f))).toBe(true);
  });
});

describe("base SIN migrar (migracion 056): vacio honesto y la transaccion sigue viva", () => {
  const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

  it("42703 (columnas de procedencia inexistentes): disponible=false, lista vacia, sin lanzar y con la misma sesion utilizable", async () => {
    const err = Object.assign(new Error('column "fuente" does not exist'), { code: "42703" });
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.known_zone where organization_id/i, respond: () => err }, SIGUIENTE]);
    const repo = new PostgresRestaurantesRepository(session);
    const r = await reporteColoniasAmbiguas(repo, "00000000-0000-4000-8000-0000000000b1");
    expect(r).toEqual({ disponible: false, total: 0, paraRevisar: 0, sinAsignar: 0, ambiguas: 0, filas: [] });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de compatibilidad se propaga (no se traga)", async () => {
    const boom = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.known_zone where organization_id/i, respond: () => boom }]);
    await expect(new PostgresRestaurantesRepository(session).listColoniasReferencia("00000000-0000-4000-8000-0000000000b1")).rejects.toThrow(/deadlock/);
  });
});
