import { describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { HEALTH_PUBLIC_CACHE_MS, healthRoutes } from "../src/routes/health.ts";
import { comprobarBaseDeDatos, estadoRateLimiter, evaluarCrons, infoVersion } from "../src/salud/health.ts";
import type { CronHeartbeatRow } from "../src/salud/motor.ts";
import { buildTestDeps } from "./fixtures.ts";

function engineQue(queryImpl: (sql: string) => Promise<unknown>): TenancyEngine & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    async withAppSession<T>(_claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<T>): Promise<T> {
      const session: TenantDbSession = {
        query: async <R>(sql: string) => {
          llamadas.push(sql);
          await queryImpl(sql);
          return { rows: [] as R[] };
        },
        exec: async () => undefined,
      };
      return fn(session);
    },
  };
}

async function appConEngine(engine: TenancyEngine) {
  const { deps } = await buildTestDeps();
  const conEngine = { ...deps, engine };
  return { app: buildApp(conEngine), deps: conEngine };
}

describe("GET /health", () => {
  it("200 {ok:true,status:ok} con la BD respondiendo, y consulta la BD de verdad (select 1)", async () => {
    const engine = engineQue(async () => undefined);
    const { app } = await appConEngine(engine);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ok" });
    expect(engine.llamadas).toEqual(["select 1 as ok;"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("503 {ok:false,status:degradado} cuando la BD lanza (fallo inyectado), sin filtrar el mensaje del driver", async () => {
    const engine = engineQue(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password authentication failed for user postgres");
    });
    const { app } = await appConEngine(engine);
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const texto = await res.text();
    expect(JSON.parse(texto)).toEqual({ ok: false, status: "degradado" });
    expect(texto).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|password|postgres/);
  });

  it("503 cuando la BD no responde dentro del timeout (consulta colgada)", async () => {
    const engine = engineQue(() => new Promise(() => undefined));
    const { deps } = await buildTestDeps();
    const app = healthRoutes({ ...deps, engine }, { dbTimeoutMs: 20 });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: "degradado" });
  });

  it("sin secreto (o con secreto incorrecto) NUNCA devuelve el detalle, y no da 401 (no es un oráculo)", async () => {
    const { app } = await appConEngine(engineQue(async () => undefined));
    const mal = await app.request("/health", { headers: { "x-atiende-internal-secret": "incorrecto" } });
    expect(mal.status).toBe(200);
    expect(await mal.json()).toEqual({ ok: true, status: "ok" });
  });

  it("con el secreto interno (header custom o Bearer de Vercel Cron) devuelve versión, BD, crons y rate limiter", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp({ ...deps, engine: engineQue(async () => undefined) });
    for (const headers of [{ "x-atiende-internal-secret": deps.env.internalSecret }, { authorization: `Bearer ${deps.env.internalSecret}` }]) {
      const res = await app.request("/health", { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        status: "ok",
        db: { ok: true, motivo: null },
        crons: { estado: "sin_medir" },
        rateLimiter: { modo: expect.stringMatching(/^(distribuido|memoria)$/) },
      });
      expect(body).toHaveProperty("version");
    }
  });

  it("el detalle también degrada a 503 con la BD caída y conserva el motivo grueso (sin mensaje crudo)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp({
      ...deps,
      engine: engineQue(async () => {
        throw new Error("secreto-interno-del-driver");
      }),
    });
    const res = await app.request("/health", { headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    expect(res.status).toBe(503);
    const texto = await res.text();
    expect(JSON.parse(texto)).toMatchObject({ ok: false, status: "degradado", db: { ok: false, motivo: "error" } });
    expect(texto).not.toContain("secreto-interno-del-driver");
  });

  it("el sondeo público se cachea unos segundos (no genera un select 1 por request anónimo) y el detalle siempre sondea en vivo", async () => {
    vi.useFakeTimers();
    try {
      const engine = engineQue(async () => undefined);
      const { deps } = await buildTestDeps();
      const app = healthRoutes({ ...deps, engine });
      await app.request("/health");
      await app.request("/health");
      expect(engine.llamadas).toHaveLength(1);
      await app.request("/health", { headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
      expect(engine.llamadas).toHaveLength(2);
      vi.setSystemTime(Date.now() + HEALTH_PUBLIC_CACHE_MS + 1);
      await app.request("/health");
      expect(engine.llamadas).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("salud/health.ts", () => {
  it("comprobarBaseDeDatos clasifica ok / error / timeout y nunca lanza", async () => {
    expect(await comprobarBaseDeDatos(engineQue(async () => undefined))).toMatchObject({ ok: true, motivo: null });
    expect(await comprobarBaseDeDatos(engineQue(async () => Promise.reject(new Error("x"))))).toMatchObject({ ok: false, motivo: "error" });
    expect(await comprobarBaseDeDatos(engineQue(() => new Promise(() => undefined)), 10)).toMatchObject({ ok: false, motivo: "timeout" });
  });

  const ahora = new Date("2026-09-30T12:00:00Z");
  const fila = (cronName: string, over: Partial<CronHeartbeatRow> = {}): CronHeartbeatRow => ({
    cronName,
    lastStartedAt: "2026-09-30T05:00:00Z",
    lastFinishedAt: "2026-09-30T05:00:10Z",
    lastStatus: "ok",
    lastError: null,
    lastDurationMs: 10,
    consecutiveFailures: 0,
    ...over,
  });

  it("evaluarCrons: sin lector, lector que lanza o tabla inexistente (null) => sin_medir, nunca un error", async () => {
    expect(await evaluarCrons(undefined, ahora)).toMatchObject({ estado: "sin_medir" });
    expect(await evaluarCrons(async () => { throw new Error("42P01"); }, ahora)).toEqual({ estado: "sin_medir", motivo: "lectura_fallida" });
    expect(await evaluarCrons(async () => null, ahora)).toEqual({ estado: "sin_medir", motivo: "tabla_de_latidos_no_disponible" });
  });

  it("evaluarCrons reutiliza juzgarLatido: ok / vencido / error / sin_latido contra los crons de vercel.json", async () => {
    const res = await evaluarCrons(
      async () => [
        fila("/internal/licitaciones/discover-tenders"),
        fila("/internal/licitaciones/deadline-reminders", { lastFinishedAt: "2026-09-27T06:00:00Z" }),
        fila("/internal/licitaciones/alert-notifications", { lastStatus: "error", lastError: "boom" }),
      ],
      ahora,
    );
    expect(res.estado).toBe("medido");
    if (res.estado !== "medido") return;
    expect(res.ok).toBe(1);
    expect(res.vencido).toBe(1);
    expect(res.error).toBe(1);
    expect(res.sinLatido).toBe(res.total - 3);
    expect(res.conProblema).toContainEqual({ cronName: "/internal/licitaciones/deadline-reminders", estado: "vencido" });
    expect(JSON.stringify(res)).not.toContain("boom");
  });

  it("estadoRateLimiter e infoVersion leen solo configuración", () => {
    expect(estadoRateLimiter({})).toEqual({ modo: "memoria" });
    expect(estadoRateLimiter({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" })).toEqual({ modo: "distribuido" });
    expect(estadoRateLimiter({ UPSTASH_REDIS_REST_URL: "https://x" })).toEqual({ modo: "memoria" });
    expect(infoVersion({})).toEqual({ commit: null, entorno: null });
    expect(infoVersion({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef", VERCEL_ENV: "production" })).toEqual({ commit: "0123456", entorno: "production" });
  });
});
