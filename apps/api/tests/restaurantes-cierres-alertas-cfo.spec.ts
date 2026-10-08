// CFO-09: el tick /internal/restaurantes/cierres-dia (08:20 UTC, SIN cron nuevo) avisa los hallazgos del CFO del dia de negocio que cerro. Cada caso
// afirma el EFECTO: que el tick llama a las alertas (una transaccion por organizacion), que repetirlo no repite avisos, que un fallo de alertas NO cambia
// el resultado del cierre (solo deja el latido parcial) y que sin CFO / con la base sin migrar el tick sigue igual. Reloj fijo: miercoles 12:00 de Merida.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { DATOS_VACIOS, InMemoryCierreRepository } from "@atiende/domain-restaurantes";
import { InMemoryCfoRepository, CfoSinAccesoError } from "@atiende/domain-restaurantes/cfo";
import type { CfoRepository } from "@atiende/domain-restaurantes/cfo";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";
import { SUCURSALES_PM_SINTETICAS, generarDatasetSintetico } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";

const MIERCOLES_MERIDA = "2026-09-30T18:00:00.000Z";
const IDS = SUCURSALES_PM_SINTETICAS.map((s) => s.propertyId);
const D = generarDatasetSintetico({ hasta: "2026-09-30", diasRango: 120 });
const COBERTURA = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-30", zona: "America/Merida", corte: "01:00:00" }));

function cfoRepo(): CfoRepository {
  return new InMemoryCfoRepository({
    sucursales: IDS,
    dataset: { ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario, comandasPos: D.comandasPos, clientesResumen: D.clientes, agotados: D.agotados, cobertura: COBERTURA, srResumen: D.srResumen },
  });
}

interface Emision { readonly evento: string; readonly organizationId: string; readonly dedupe: string; readonly severidad: string }

async function armar(opts: { cfo?: (() => CfoRepository) | null } = {}) {
  const { deps: base, organizationId } = await buildTestDeps();
  const emisiones: Emision[] = [];
  const vistas = new Set<string>();
  let transacciones = 0;
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        const dedupe = `${String(p[0])}|${String(p[10])}`;
        const nueva = !vistas.has(dedupe);
        vistas.add(dedupe);
        if (nueva && String(p[2]).startsWith("restaurantes.cfo.")) emisiones.push({ evento: String(p[2]), organizationId: String(p[0]), dedupe: String(p[10]), severidad: String(p[4]) });
        return { rows: [{ emit_notification: nueva ? 1 : 0 }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = {
    withAppSession: (claims, fn) => {
      transacciones++;
      return base.engine.withAppSession(claims, (s) => fn(envolver(s)));
    },
  };
  const latidos: Array<{ status: string; error: string | null }> = [];
  const original = base.saludRepo.recordCronHeartbeat.bind(base.saludRepo);
  const saludRepo = Object.assign(Object.create(base.saludRepo) as typeof base.saludRepo, {
    recordCronHeartbeat: async (input: Parameters<typeof original>[0]) => {
      latidos.push({ status: String((input as { status?: string }).status), error: ((input as { error?: string | null }).error ?? null) as string | null });
      return original(input);
    },
  });
  const cierreRepo = new InMemoryCierreRepository({
    calcular: () => ({ ...DATOS_VACIOS, pedidos: 5, ventasCentavos: 38575, ticketPromedioCentavos: 7715 }),
    // Siete sucursales de UNA organizacion (las del dataset sintetico), zona de Merida.
    sucursales: IDS.map((propertyId) => ({ organizationId, propertyId, zonaHoraria: "America/Merida" })),
  });
  const cfo = opts.cfo === undefined ? cfoRepo : opts.cfo;
  const deps: AppDeps = { ...base, engine, saludRepo, cierreRepo: () => cierreRepo, ...(cfo ? { cfoRestaurantesRepo: cfo } : {}) };
  if (!cfo) delete (deps as { cfoRestaurantesRepo?: unknown }).cfoRestaurantesRepo;
  const app = buildApp(deps);
  const tick = () => app.request("/internal/restaurantes/cierres-dia?dias=2", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
  return { app, tick, emisiones, latidos, organizationId, transacciones: () => transacciones };
}

describe("tick de cierres + alertas de hallazgos del CFO", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MIERCOLES_MERIDA));
  });
  afterEach(() => vi.useRealTimers());

  it("el tick llama a las alertas: avisa los hallazgos del dia que cerro a la organizacion y los cierres salen igual", async () => {
    const { tick, emisiones, organizationId } = await armar();
    const res = await tick();
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ ok: true, status: "ok", sucursales: 7 });
    expect(r.creados).toBeGreaterThan(0);
    expect(r.alertas).toMatchObject({ estado: "ok", organizaciones: 1, fallos: [] });
    expect(r.alertas.emitidas).toBeGreaterThan(0);
    expect(r.alertas.emitidas).toBeLessThanOrEqual(5);
    expect(emisiones).toHaveLength(r.alertas.emitidas);
    for (const e of emisiones) {
      expect(["restaurantes.cfo.hallazgo", "restaurantes.cfo.hallazgo_sin_monto"]).toContain(e.evento);
      expect(e.organizationId).toBe(organizationId);
      expect(e.dedupe).toMatch(/-2026-09-29$/); // ayer en Merida, no la fecha UTC
    }
  });

  it("repetir el tick no repite las alertas ni los cierres (idempotente)", async () => {
    const { tick, emisiones } = await armar();
    const r1 = await (await tick()).json();
    const r2 = await (await tick()).json();
    expect(r1.alertas.emitidas).toBeGreaterThan(0);
    expect(r2.alertas).toMatchObject({ emitidas: 0, sinNuevas: r1.alertas.emitidas });
    expect(r2).toMatchObject({ creados: 0 });
    expect(emisiones).toHaveLength(r1.alertas.emitidas);
  });

  it("un fallo de alertas NO cambia el resultado del cierre: 200, ok y creados iguales, fallo registrado y latido parcial", async () => {
    const sin = await armar({ cfo: null });
    const rSin = await (await sin.tick()).json();
    const conFallo = await armar({
      cfo: () => {
        throw new CfoSinAccesoError("sin acceso (simulado)");
      },
    });
    const res = await conFallo.tick();
    expect(res.status).toBe(200);
    const r = await res.json();
    expect({ ok: r.ok, status: r.status, sucursales: r.sucursales, creados: r.creados, existentes: r.existentes, sinActividad: r.sinActividad, avisos: r.avisos, fallos: r.fallos }).toEqual({
      ok: rSin.ok, status: rSin.status, sucursales: rSin.sucursales, creados: rSin.creados, existentes: rSin.existentes, sinActividad: rSin.sinActividad, avisos: rSin.avisos, fallos: rSin.fallos,
    });
    expect(r.alertas.fallos).toEqual([{ organizationId: conFallo.organizationId, error: "sin acceso (simulado)" }]);
    expect(r.alertas.emitidas).toBe(0);
    expect(conFallo.latidos.at(-1)).toMatchObject({ status: "error" });
    expect(conFallo.latidos.at(-1)!.error).toMatch(/alertas del CFO/);
    expect(sin.latidos.at(-1)).toMatchObject({ status: "ok" });
  });

  it("una transaccion por organizacion para las alertas (ademas de una por sucursal para los cierres)", async () => {
    const a = await armar({ cfo: null });
    await a.tick();
    const b = await armar();
    await b.tick();
    expect(b.transacciones() - a.transacciones()).toBe(1);
  });

  it("despliegue sin CFO: el tick sigue igual y reporta 'no_configurado' (sin emitir nada)", async () => {
    const { tick, emisiones } = await armar({ cfo: null });
    const r = await (await tick()).json();
    expect(r).toMatchObject({ ok: true, alertas: { estado: "no_configurado", emitidas: 0, fallos: [] } });
    expect(emisiones).toHaveLength(0);
  });

  it("base del CFO sin migrar (081): no emite, lo reporta y el latido queda ok", async () => {
    const sinMigrar = () => new InMemoryCfoRepository({ sucursales: IDS, migraciones: { m081: false, m082: false, m083: false, m084: false } });
    const { tick, emisiones, latidos } = await armar({ cfo: sinMigrar });
    const r = await (await tick()).json();
    expect(r).toMatchObject({ ok: true, alertas: { estado: "ok", emitidas: 0, noDisponibles: 1, fallos: [] } });
    expect(emisiones).toHaveLength(0);
    expect(latidos.at(-1)).toMatchObject({ status: "ok" });
  });
});
