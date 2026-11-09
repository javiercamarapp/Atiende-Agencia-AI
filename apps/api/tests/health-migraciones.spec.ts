// Ola 4 (G4): la base Supabase real va POR DETRÁS del código (nadie aplica migraciones al fusionar). El detalle de
// /health (solo con el secreto interno) reporta las versiones aplicadas vía `core.migraciones_aplicadas()` (0101), y el
// smoke post-deploy las compara contra supabase/migrations del checkout para AVISAR si faltan. El público nunca las ve:
// en un repo público, saber qué migraciones faltan en producción diría qué arreglos no están aplicados.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { leerMigracionesAplicadas } from "../src/salud/migraciones.ts";
import { compararMigraciones, codigoDeSalida, runSmoke, versionesDelRepo } from "../../../scripts/smoke-post-deploy/smoke.ts";
import { buildTestDeps } from "./fixtures.ts";

function pgError(code: string): Error {
  const mensaje = code === "42883" ? "function core.migraciones_aplicadas() does not exist" : `pg ${code}`;
  return Object.assign(new Error(mensaje), { code });
}

/** Motor falso: `select 1` contesta; la consulta de migraciones devuelve `filas` o lanza `error`. */
function engineMigraciones(opts: { filas?: string[]; error?: Error }): TenancyEngine & { claims: Array<string | null> } {
  const claims: Array<string | null> = [];
  return {
    claims,
    async withAppSession<T>(c: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>): Promise<T> {
      claims.push(c.userId);
      const session: TenantDbSession = {
        query: async <R>(sql: string) => {
          if (sql.includes("core.migraciones_aplicadas")) {
            if (opts.error) throw opts.error;
            return { rows: (opts.filas ?? []).map((version) => ({ version })) as R[] };
          }
          return { rows: [] as R[] };
        },
        exec: async () => undefined,
      };
      return fn(session);
    },
  };
}

describe("leerMigracionesAplicadas", () => {
  it("con la función migrada devuelve las versiones ordenadas y la máxima, en sesión de SISTEMA (userId null)", async () => {
    const engine = engineMigraciones({ filas: ["20240101000900", "20240101000001", "20240101000500"] });
    expect(await leerMigracionesAplicadas(engine)).toEqual({
      estado: "medido",
      aplicadas: ["20240101000001", "20240101000500", "20240101000900"],
      maxima: "20240101000900",
    });
    expect(engine.claims).toEqual([null]);
  });

  it("base sin la 0101 (42883) -> sin_medir/funcion_no_migrada, nunca lanza", async () => {
    expect(await leerMigracionesAplicadas(engineMigraciones({ error: pgError("42883") }))).toEqual({ estado: "sin_medir", motivo: "funcion_no_migrada" });
  });

  it("sin registro de la CLI (0 filas) -> sin_medir/sin_registro", async () => {
    expect(await leerMigracionesAplicadas(engineMigraciones({ filas: [] }))).toEqual({ estado: "sin_medir", motivo: "sin_registro" });
  });

  it("cualquier otro error -> sin_medir/error, nunca lanza", async () => {
    expect(await leerMigracionesAplicadas(engineMigraciones({ error: pgError("57014") }))).toEqual({ estado: "sin_medir", motivo: "error" });
  });
});

describe("GET /health y las migraciones aplicadas", () => {
  it("el detalle (con secreto) trae `migraciones`; el público NO", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp({ ...deps, engine: engineMigraciones({ filas: ["20240101000001", "20240101000002"] }) });
    const detalle = (await (await app.request("/health", { headers: { "x-atiende-internal-secret": deps.env.internalSecret } })).json()) as {
      migraciones?: unknown;
    };
    expect(detalle.migraciones).toEqual({ estado: "medido", aplicadas: ["20240101000001", "20240101000002"], maxima: "20240101000002" });
    const publico = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(publico).not.toHaveProperty("migraciones");
  });

  it("contra la base sin migrar el detalle sigue en 200 y dice sin_medir", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp({ ...deps, engine: engineMigraciones({ error: pgError("42883") }) });
    const res = await app.request("/health", { headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { migraciones: unknown }).migraciones).toEqual({ estado: "sin_medir", motivo: "funcion_no_migrada" });
  });
});

describe("smoke post-deploy: ¿la base va por detrás del repo?", () => {
  it("compararMigraciones: faltan las del repo que no están aplicadas (también huecos por debajo de la máxima)", () => {
    expect(compararMigraciones(["20240101000001", "20240101000830", "20240101000900"], ["20240101000001", "20240101000900"])).toEqual({
      alDia: false,
      faltan: ["20240101000830"],
    });
    expect(compararMigraciones(["20240101000001"], ["20240101000001", "20240101000002"])).toEqual({ alDia: true, faltan: [] });
  });

  it("versionesDelRepo lee el prefijo de supabase/migrations real", () => {
    const v = versionesDelRepo();
    expect(v.length).toBeGreaterThan(300);
    expect(v.every((x) => /^\d{14}$/.test(x))).toBe(true);
    expect(v).toEqual([...v].sort());
  });

  async function appFetch(filas: string[]) {
    const { deps } = await buildTestDeps();
    const app = buildApp({ ...deps, engine: engineMigraciones({ filas }) });
    return {
      secreto: deps.env.internalSecret,
      fetchImpl: (url: string, init?: RequestInit) => {
        const u = new URL(url);
        return Promise.resolve(app.request(u.pathname + u.search, init));
      },
    };
  }

  it("base por detrás: la comprobación AVISA (ok, aviso) con el conteo, sin listar versiones", async () => {
    const { secreto, fetchImpl } = await appFetch(["20240101000001"]);
    const r = await runSmoke("https://smoke.test", { fetchImpl, migraciones: { secreto, versionesRepo: ["20240101000001", "20240101000900", "20240101000901"] } });
    const m = r.find((x) => x.name.includes("migraciones"));
    expect(m).toMatchObject({ ok: true, aviso: true });
    expect(m?.detail).toContain("2 migraciones");
    expect(m?.detail).not.toContain("20240101000900");
    expect(codigoDeSalida(r, { estricto: false })).toBe(0);
    expect(codigoDeSalida(r, { estricto: true })).toBe(1);
  });

  it("base al día: ok sin aviso", async () => {
    const { secreto, fetchImpl } = await appFetch(["20240101000001", "20240101000900"]);
    const r = await runSmoke("https://smoke.test", { fetchImpl, migraciones: { secreto, versionesRepo: ["20240101000001", "20240101000900"] } });
    expect(r.find((x) => x.name.includes("migraciones"))).toMatchObject({ ok: true, aviso: false });
    expect(codigoDeSalida(r, { estricto: true })).toBe(0);
  });

  it("sin secreto no se puede medir: aviso honesto, nunca un 'al día' inventado", async () => {
    const { fetchImpl } = await appFetch(["20240101000001"]);
    const r = await runSmoke("https://smoke.test", { fetchImpl, migraciones: { secreto: null, versionesRepo: ["20240101000001"] } });
    const m = r.find((x) => x.name.includes("migraciones"));
    expect(m).toMatchObject({ ok: true, aviso: true });
    expect(m?.detail).toContain("sin medir");
  });

  it("base sin la 0101: aviso sin_medir (funcion_no_migrada)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp({ ...deps, engine: engineMigraciones({ error: pgError("42883") }) });
    const fetchImpl = (url: string, init?: RequestInit) => Promise.resolve(app.request(new URL(url).pathname, init));
    const r = await runSmoke("https://smoke.test", { fetchImpl, migraciones: { secreto: deps.env.internalSecret, versionesRepo: ["20240101000001"] } });
    expect(r.find((x) => x.name.includes("migraciones"))?.detail).toContain("funcion_no_migrada");
  });
});
