import { describe, expect, it, vi } from "vitest";
import { InMemoryResumenDiarioRepository } from "@atiende/db";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { HEALTH_PUBLIC_CACHE_MS, healthRoutes } from "../src/routes/health.ts";
import { cadenciaMinutosPorRuta, rutasDeCronDeclaradas } from "../src/salud/cadencia.ts";
import { comprobarBaseDeDatos, estadoRateLimiter, evaluarCrons, infoVersion, lectorConTimeout, resumirCronsPublico, senalPublicaDeCrons } from "../src/salud/health.ts";
import type { CronHeartbeatRow } from "../src/salud/motor.ts";
import { ProductionResumenDiarioRepository } from "../src/production/resumen-diario-repository.ts";
import { buildTestDeps } from "./fixtures.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

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
    expect(await res.json()).toEqual({ ok: true, status: "ok", crons: "sin_latido" }); // sin latidos sembrados: ningun cron de alta frecuencia corrio
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
    expect(JSON.parse(texto)).toEqual({ ok: false, status: "degradado", crons: "sin_medir" }); // con la BD caida no se intenta otra lectura
    expect(texto).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|password|postgres/);
  });

  it("503 cuando la BD no responde dentro del timeout (consulta colgada)", async () => {
    const engine = engineQue(() => new Promise(() => undefined));
    const { deps } = await buildTestDeps();
    const app = healthRoutes({ ...deps, engine }, { dbTimeoutMs: 20 });
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, status: "degradado", crons: "sin_medir" });
  });

  it("sin secreto (o con secreto incorrecto) NUNCA devuelve el detalle, y no da 401 (no es un oráculo)", async () => {
    const { app } = await appConEngine(engineQue(async () => undefined));
    const mal = await app.request("/health", { headers: { "x-atiende-internal-secret": "incorrecto" } });
    expect(mal.status).toBe(200);
    expect(await mal.json()).toEqual({ ok: true, status: "ok", crons: "sin_latido" });
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
        crons: { estado: "medido", total: rutasDeCronDeclaradas().length, ok: 0, sinLatido: rutasDeCronDeclaradas().length },
        cronsSenal: "sin_latido",
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

describe("GET /health -- senal publica de crons", () => {
  const AHORA = new Date("2026-10-05T12:00:00Z");
  const hace = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString();
  /** Latido de cada cron declarado, `min` minutos atras (o el que diga `edades`). */
  const latidos = (min: number, edades: Record<string, number> = {}) =>
    rutasDeCronDeclaradas().map((cronName) => ({ cronName, lastStartedAt: hace(edades[cronName] ?? min), lastFinishedAt: hace(edades[cronName] ?? min), lastStatus: "ok" as const, lastError: null, lastDurationMs: 5, consecutiveFailures: 0 }));

  async function publica(configurar: (repo: InMemoryResumenDiarioRepository) => void) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    try {
      const { deps } = await buildTestDeps();
      const repo = new InMemoryResumenDiarioRepository();
      configurar(repo);
      const app = buildApp({ ...deps, engine: engineQue(async () => undefined), resumenDiarioRepo: repo });
      const res = await app.request("/health");
      return { status: res.status, texto: await res.text() };
    } finally {
      vi.useRealTimers();
    }
  }

  it("latidos frescos de todos los crons => crons:'ok'", async () => {
    const r = await publica((repo) => repo.seedCronHeartbeats(latidos(1)));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.texto)).toEqual({ ok: true, status: "ok", crons: "ok" });
  });

  it("sin ningun latido (0 filas, como hoy en produccion) => crons:'sin_latido' y el HTTP sigue 200", async () => {
    const r = await publica((repo) => repo.seedCronHeartbeats([]));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.texto)).toEqual({ ok: true, status: "ok", crons: "sin_latido" });
  });

  it("un cron de alta frecuencia sin latido (whatsapp/dispatch, */5) => 'sin_latido' aunque los demas esten frescos", async () => {
    const r = await publica((repo) => repo.seedCronHeartbeats(latidos(1).filter((f) => f.cronName !== "/internal/whatsapp/dispatch")));
    expect(JSON.parse(r.texto).crons).toBe("sin_latido");
  });

  it("un cron DIARIO sin latido no cuenta como sin_latido (puede ser que aun no le toque su primera corrida)", async () => {
    const r = await publica((repo) => repo.seedCronHeartbeats(latidos(1).filter((f) => f.cronName !== "/internal/restaurantes/cierres-dia")));
    expect(JSON.parse(r.texto).crons).toBe("ok");
  });

  it("latidos viejos (mas de 3 veces la cadencia) => 'atrasados'; justo dentro del limite sigue 'ok'", async () => {
    const viejo = await publica((repo) => repo.seedCronHeartbeats(latidos(1, { "/internal/whatsapp/dispatch": 16 }))); // */5: limite 15 min
    expect(JSON.parse(viejo.texto).crons).toBe("atrasados");
    const limite = await publica((repo) => repo.seedCronHeartbeats(latidos(1, { "/internal/whatsapp/dispatch": 14 })));
    expect(JSON.parse(limite.texto).crons).toBe("ok");
    const diario = await publica((repo) => repo.seedCronHeartbeats(latidos(1, { "/internal/restaurantes/cierres-dia": 3 * 24 * 60 + 1 })));
    expect(JSON.parse(diario.texto).crons).toBe("atrasados");
  });

  it("tabla/funcion de latidos ausente (42883, base sin migrar) => 'sin_medir' y 200, nunca un 500", async () => {
    const r = await publica((repo) => repo.setMigracionPendiente(true));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.texto)).toEqual({ ok: true, status: "ok", crons: "sin_medir" });
  });

  it("una lectura que falla => 'sin_medir'", async () => {
    const r = await publica((repo) => repo.setFallando(true));
    expect(JSON.parse(r.texto).crons).toBe("sin_medir");
  });

  it("el cuerpo publico no contiene nombres de crons, rutas ni errores", async () => {
    const r = await publica((repo) => repo.seedCronHeartbeats(latidos(1, { "/internal/whatsapp/dispatch": 90 }).map((f) => (f.cronName === "/internal/hoteles/night-audit" ? { ...f, lastStatus: "error" as const, lastError: "boom-secreto" } : f))));
    expect(Object.keys(JSON.parse(r.texto)).sort()).toEqual(["crons", "ok", "status"]);
    expect(r.texto).not.toMatch(/internal|whatsapp|night-audit|boom-secreto|dispatch/);
  });

  it("la senal se cachea con el sondeo publico: dos requests seguidos leen los latidos una sola vez", async () => {
    const { deps } = await buildTestDeps();
    const repo = new InMemoryResumenDiarioRepository();
    const leer = vi.spyOn(repo, "listCronHeartbeatsForSystem");
    const app = buildApp({ ...deps, engine: engineQue(async () => undefined), resumenDiarioRepo: repo });
    await app.request("/health");
    await app.request("/health");
    expect(leer).toHaveBeenCalledTimes(1);
  });

  it("adaptador REAL contra la base sin migrar: la funcion de latidos no existe (42883), vive en su PROPIA transaccion y /health sigue en 200 con 'sin_medir'", async () => {
    const { deps } = await buildTestDeps();
    const sesiones: AbortAwareFakeSession[] = [];
    const engine = {
      async withAppSession<T>(_c: unknown, fn: (s: AbortAwareFakeSession) => Promise<T>): Promise<T> {
        // una transaccion NUEVA por llamada, como el motor real
        const sesion = new AbortAwareFakeSession([
          { match: /list_cron_heartbeats_for_system/, respond: () => Object.assign(new Error("function core.list_cron_heartbeats_for_system() does not exist"), { code: "42883" }) },
          { match: /select 1/, respond: () => [{ ok: 1 }] },
        ]);
        sesiones.push(sesion);
        return fn(sesion);
      },
    };
    const app = buildApp({ ...deps, engine, resumenDiarioRepo: new ProductionResumenDiarioRepository(engine as never) } as never);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ok", crons: "sin_medir" });
    expect(sesiones).toHaveLength(2); // select 1 y la lectura de latidos, cada una en su transaccion
  });

  it("un lector colgado agota el tiempo y la senal es 'sin_medir' (no cuelga /health)", async () => {
    const { deps } = await buildTestDeps();
    const colgado = new InMemoryResumenDiarioRepository();
    colgado.listCronHeartbeatsForSystem = () => new Promise(() => undefined);
    const app = healthRoutes({ ...deps, engine: engineQue(async () => undefined), resumenDiarioRepo: colgado }, { dbTimeoutMs: 20 });
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true, status: "ok", crons: "sin_medir" });
  });

  it("con el secreto interno el detalle sigue trayendo el estado por cron y ademas la senal agregada", async () => {
    const { deps } = await buildTestDeps();
    const repo = new InMemoryResumenDiarioRepository();
    repo.seedCronHeartbeats(latidos(1).filter((f) => f.cronName !== "/internal/whatsapp/dispatch"));
    const app = buildApp({ ...deps, engine: engineQue(async () => undefined), resumenDiarioRepo: repo });
    const body = (await (await app.request("/health", { headers: { authorization: `Bearer ${deps.env.internalSecret}` } })).json()) as { crons: { conProblema: Array<{ cronName: string; estado: string }> }; cronsSenal: string };
    expect(body.cronsSenal).toBe("sin_latido");
    expect(body.crons.conProblema).toContainEqual({ cronName: "/internal/whatsapp/dispatch", estado: "sin_latido" });
  });
});

describe("salud/health.ts -- resumirCronsPublico", () => {
  const ahora = new Date("2026-10-05T12:00:00Z");
  const todos = (edadMin: number) => rutasDeCronDeclaradas().map((cronName) => ({ cronName, lastStartedAt: null, lastFinishedAt: new Date(ahora.getTime() - edadMin * 60_000).toISOString(), lastStatus: "ok" as const, lastError: null, lastDurationMs: 1, consecutiveFailures: 0 }));

  it("null => sin_medir; todo fresco => ok; los crons de cadencia indeterminada nunca cuentan", () => {
    expect(resumirCronsPublico(null, ahora)).toBe("sin_medir");
    expect(resumirCronsPublico(todos(1), ahora)).toBe("ok");
    expect(Object.values(cadenciaMinutosPorRuta()).every((c) => c > 0)).toBe(true);
  });

  it("un cron en error pero puntual NO es 'atrasados' (la senal mide si corren, no si terminan bien)", () => {
    const filas = todos(1).map((f, i) => (i === 0 ? { ...f, lastStatus: "error" as const, lastError: "x" } : f));
    expect(resumirCronsPublico(filas, ahora)).toBe("ok");
  });

  it("senalPublicaDeCrons: sin lector => sin_medir; lector que lanza => sin_medir; lectorConTimeout rechaza al agotarse", async () => {
    expect(await senalPublicaDeCrons(undefined, ahora)).toBe("sin_medir");
    expect(await senalPublicaDeCrons(async () => { throw new Error("42P01"); }, ahora)).toBe("sin_medir");
    await expect(lectorConTimeout(() => new Promise(() => undefined), 10)()).rejects.toThrow("timeout_lectura_latidos");
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
