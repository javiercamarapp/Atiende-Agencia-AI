// Los 3 crons agendados por el brief plataforma-pm-crons-y-vigilancia: cierres-dia (R-42), repartidor-licencias (R-15) y
// prueba-avisos (PL-16). Cubre lo que el contrato general (vercel-crons-contrato.spec.ts) no ve: el horario elegido, GET con Bearer
// (la forma en que Vercel invoca), el latido que ahora dejan en core.cron_heartbeat, el kill switch y el fallo parcial (200 con el
// detalle + latido en error). Los repos son dobles en memoria; el SQL real se prueba en los verify-* de cada tema.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemorySaludRepository } from "@atiende/db";
import { InMemoryCierreRepository, DATOS_VACIOS, InMemoryRepartidorPerfilRepository } from "@atiende/domain-restaurantes";
import type { CierreSucursal } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { buildTestDeps } from "./fixtures.ts";

const CIERRES = "/internal/restaurantes/cierres-dia";
const LICENCIAS = "/internal/restaurantes/repartidor-licencias";
const PRUEBA = "/internal/plataforma/prueba-avisos";
const TODOS = [CIERRES, LICENCIAS, PRUEBA] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(path.resolve(here, "..", "..", "..", "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };

const ORG = "00000000-0000-0000-0000-0000000000a1";
const SUCURSAL_A: CierreSucursal = { organizationId: ORG, propertyId: "00000000-0000-0000-0000-0000000000b1", zonaHoraria: "America/Mexico_City" };
const SUCURSAL_B: CierreSucursal = { organizationId: ORG, propertyId: "00000000-0000-0000-0000-0000000000b2", zonaHoraria: "America/Mexico_City" };

class CierreQueFallaEn extends InMemoryCierreRepository {
  override async generar(...args: Parameters<InMemoryCierreRepository["generar"]>): ReturnType<InMemoryCierreRepository["generar"]> {
    if (args[1] === SUCURSAL_B.propertyId) throw new Error("boom de una sucursal");
    return super.generar(...args);
  }
}

/** Sesion de sistema que no devuelve filas: prueba-avisos no reclama nada (disponible, 0 avisos). */
const engineVacio = { withAppSession: async (_c: unknown, fn: (s: unknown) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }), exec: async () => undefined }) };

async function armar(extra: Partial<AppDeps> = {}) {
  const base = await buildTestDeps();
  const deps = {
    ...base.deps,
    engine: engineVacio,
    cierreRepo: () => new InMemoryCierreRepository({ calcular: () => ({ ...DATOS_VACIOS, pedidos: 1 }), sucursales: [SUCURSAL_A] }),
    repartidorPerfilRepo: () => new InMemoryRepartidorPerfilRepository({ licencias: [] }),
    ...extra,
  } as unknown as AppDeps;
  const salud = deps.saludRepo as InMemorySaludRepository;
  const superadminId = randomUUID();
  salud.addPlatformSuperadmin(superadminId);
  const latido = async (cron: string) => (await salud.listCronHeartbeatsForSuperadmin(superadminId)).find((h) => h.cronName === cron);
  return { deps, app: buildApp(deps), latido, bearer: { authorization: `Bearer ${deps.env.internalSecret}` } };
}

describe("horarios en vercel.json", () => {
  it("los 3 estan agendados una vez al dia, escalonados y sin chocar con otro cron diario", () => {
    const esperado: Record<string, string> = { [CIERRES]: "20 8 * * *", [LICENCIAS]: "35 13 * * *", [PRUEBA]: "0 14 * * *" };
    for (const [ruta, schedule] of Object.entries(esperado)) expect(vercel.crons.filter((c) => c.path === ruta), ruta).toEqual([{ path: ruta, schedule }]);
    const diarios = vercel.crons.filter((c) => /^\d+ \d+ \* \* \*$/.test(c.schedule)).map((c) => c.schedule);
    expect(new Set(diarios).size).toBe(diarios.length);
  });

  it("cierres-dia corre despues del cierre de las 01:00 de Merida (UTC-6 sin horario de verano): 08:20 UTC = 02:20 locales", () => {
    const [minuto, hora] = vercel.crons.find((c) => c.path === CIERRES)!.schedule.split(" ").map(Number) as [number, number];
    expect(((hora - 6 + 24) % 24) * 60 + minuto).toBeGreaterThan(60);
  });
});

describe.each(TODOS)("%s", (ruta) => {
  it("401 sin secreto y con secreto incorrecto (GET y POST), y no deja latido", async () => {
    const { app, latido } = await armar();
    for (const method of ["GET", "POST"]) {
      expect((await app.request(ruta, { method })).status, `${method} sin secreto`).toBe(401);
      expect((await app.request(ruta, { method, headers: { authorization: "Bearer incorrecto" } })).status, `${method} secreto malo`).toBe(401);
    }
    expect(await latido(ruta)).toBeUndefined();
  });

  it("GET con Authorization: Bearer (forma de Vercel Cron) responde 200 y deja un latido ok bajo su path exacto", async () => {
    const { app, latido, bearer } = await armar();
    const res = await app.request(ruta, { method: "GET", headers: bearer });
    expect(res.status).toBe(200);
    expect(await latido(ruta)).toMatchObject({ cronName: ruta, lastStatus: "ok", lastError: null, consecutiveFailures: 0 });
  });

  it("con el kill switch responde {skipped:'kill_switch'}, no ejecuta el barrido y el latido queda ok con la nota de pausa", async () => {
    let barridos = 0;
    const { latido, bearer, deps } = await armar({
      cierreRepo: () => {
        barridos += 1;
        return new InMemoryCierreRepository({ sucursales: [SUCURSAL_A] });
      },
      repartidorPerfilRepo: () => {
        barridos += 1;
        return new InMemoryRepartidorPerfilRepository({ licencias: [] });
      },
    });
    const pausada = buildApp({ ...deps, platformSwitchGuard: createPlatformSwitchGuard(async () => [{ scope: "cron", target: ruta }]) });
    const res = await pausada.request(ruta, { method: "GET", headers: bearer });
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect(barridos).toBe(0);
    expect((await latido(ruta))?.lastError).toMatch(/pausado por interruptor/);
  });
});

describe(`GET ${CIERRES}`, () => {
  it("parametro dias mal formado: 400 del llamador, sin latido (no es un fallo del cron)", async () => {
    const { app, latido, bearer } = await armar();
    expect((await app.request(`${CIERRES}?dias=abc`, { method: "GET", headers: bearer })).status).toBe(400);
    expect(await latido(CIERRES)).toBeUndefined();
  });

  it("una sucursal que falla no frena a las demas: 200 ok:false con el detalle, la otra sucursal queda cerrada y el latido queda en error", async () => {
    const repo = new CierreQueFallaEn({ calcular: () => ({ ...DATOS_VACIOS, pedidos: 2 }), sucursales: [SUCURSAL_A, SUCURSAL_B] });
    const { app, latido, bearer } = await armar({ cierreRepo: () => repo });
    const res = await app.request(`${CIERRES}?dias=1`, { method: "GET", headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fallos: Array<{ propertyId: string }>; creados: number };
    expect(body.ok).toBe(false);
    expect(body.fallos.map((f) => f.propertyId)).toEqual([SUCURSAL_B.propertyId]);
    expect(body.creados).toBeGreaterThan(0);
    expect(await latido(CIERRES)).toMatchObject({ lastStatus: "error", consecutiveFailures: 1 });
  });

  it("sin cierreRepo cableado el cron falla de verdad (503) y el latido lo registra como error", async () => {
    const { app, latido, bearer } = await armar({ cierreRepo: undefined });
    expect((await app.request(CIERRES, { method: "GET", headers: bearer })).status).toBe(503);
    expect(await latido(CIERRES)).toMatchObject({ lastStatus: "error" });
  });
});

describe(`GET ${LICENCIAS}`, () => {
  it("base sin migrar (not_available): 200 y el latido sigue ok (no es un fallo del cron)", async () => {
    const { app, latido, bearer } = await armar({ repartidorPerfilRepo: () => new InMemoryRepartidorPerfilRepository({ disponible: false }) });
    const res = await app.request(LICENCIAS, { method: "GET", headers: bearer });
    expect(await res.json()).toMatchObject({ ok: true, status: "not_available" });
    expect(await latido(LICENCIAS)).toMatchObject({ lastStatus: "ok" });
  });
});
