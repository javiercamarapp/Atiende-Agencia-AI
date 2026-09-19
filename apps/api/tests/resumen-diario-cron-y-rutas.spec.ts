// Resumen diario automático — cron `/internal/superadmin/resumen-diario` +
// rutas `/superadmin/resumen/*`. Tres garantías DURAS a probar:
//   1. Idempotencia: re-ejecutar el cron el MISMO día ACTUALIZA el resumen
//      de esa fecha, nunca duplica.
//   2. Envío único de correo: sin importar cuántas veces corra el cron (o se
//      pida "generar ahora") en el mismo día, Resend se llama COMO MÁXIMO
//      una vez para esa fecha.
//   3. Autorización: 401 sin token, 403 para un staff que no es superadmin —
//      mismo criterio que el resto del back office de plataforma.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCoreRepository, InMemoryResumenDiarioRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";
import { generarYPersistirResumenDiario, type ResultadoGeneracion } from "../src/resumen-diario/agregador.ts";
import { enviarCorreoResumenDiarioSiCorresponde } from "../src/resumen-diario/correo.ts";
import type { AppDeps } from "../src/deps.ts";

const CRON_PATH = "/internal/superadmin/resumen-diario";

/** `generarYPersistirResumenDiario` devuelve `ResultadoGenerarResumenDiario`
 *  (`{ ok:true, agregados, narrativa, ... } | { ok:false, motivo }`, ver el
 *  hallazgo B de esta misma auditoría) -- estos helpers de test asumen el
 *  camino feliz (`ok:true`) y fallan ruidosamente si no lo es, en vez de
 *  dejar pasar un `undefined` silencioso. */
async function generarResumenOk(deps: AppDeps, fecha: string): Promise<ResultadoGeneracion> {
  const resultado = await generarYPersistirResumenDiario(deps, fecha);
  if (!resultado.ok) throw new Error(`generarYPersistirResumenDiario no fue 'ok' para ${fecha}: ${resultado.motivo}`);
  return resultado;
}

async function makeSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<{ token: string; superadminId: string; email: string }> {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const resumenDiarioRepo = base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository;
  const superadminId = randomUUID();
  const email = "superadmin@example.com";
  coreRepo.addStaff({ id: superadminId, email, passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
  resumenDiarioRepo.addPlatformSuperadmin(superadminId);
  const token = await signAccessToken({ sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
  return { token, superadminId, email };
}

async function staffToken(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<string> {
  return signAccessToken({ sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
}

function conResendConfigurado(deps: AppDeps): AppDeps {
  return { ...deps, env: { ...deps.env, resend: { apiKey: "re_test_key", from: deps.env.resend.from } } };
}

describe("POST/GET /internal/superadmin/resumen-diario -- idempotencia", () => {
  it("sin el secreto interno -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request(CRON_PATH, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("re-ejecutar el cron el MISMO día actualiza el resumen de esa fecha, nunca lo duplica", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const headers = { "x-atiende-internal-secret": base.deps.env.internalSecret };

    const res1 = await app.request(CRON_PATH, { method: "POST", headers });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; fecha: string; generadoPor: string };
    expect(body1.ok).toBe(true);
    expect(body1.generadoPor).toBe("determinista"); // sin gateway configurado en este fixture

    // Lectura directa del repo en memoria (sin pasar por autorización HTTP) para
    // contar filas reales -- lo que importa aquí es la persistencia, no la ruta.
    const repo = base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository;
    const filaAntes = await repo.getDailyOpsSummaryForSystem(body1.fecha);
    expect(filaAntes).not.toBeNull();
    const actualizadoEn1 = filaAntes!.actualizadoEn;

    // Segunda corrida, misma fecha -- debe actualizar la MISMA fila.
    await new Promise((r) => setTimeout(r, 5));
    const res2 = await app.request(CRON_PATH, { method: "POST", headers });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { fecha: string };
    expect(body2.fecha).toBe(body1.fecha);

    const filaDespues = await repo.getDailyOpsSummaryForSystem(body1.fecha);
    expect(filaDespues).not.toBeNull();
    expect(filaDespues!.creadoEn).toBe(filaAntes!.creadoEn); // mismo `creado_en` -- nunca una fila nueva
    expect(new Date(filaDespues!.actualizadoEn).getTime()).toBeGreaterThanOrEqual(new Date(actualizadoEn1).getTime());
  });
});

describe("Correo del resumen -- UN SOLO envío por fecha", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sin RESEND_API_KEY -- el resumen se guarda igual, pero el correo se reporta 'resend_no_configurado'", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    const body = (await res.json()) as { correo: string };
    expect(body.correo).toBe("resend_no_configurado");
  });

  it("con RESEND_API_KEY y superadmins registrados -- se envía UNA vez; una segunda corrida el mismo día NO reenvía", async () => {
    const base = await buildTestDeps();
    const { email } = await makeSuperadmin(base);
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).seedPlatformSuperadminEmails([email]);
    const deps = conResendConfigurado(base.deps);
    const app = buildApp(deps);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const headers = { "x-atiende-internal-secret": deps.env.internalSecret };
    const res1 = await app.request(CRON_PATH, { method: "POST", headers });
    const body1 = (await res1.json()) as { correo: string };
    expect(body1.correo).toBe("enviado");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const res2 = await app.request(CRON_PATH, { method: "POST", headers });
    const body2 = (await res2.json()) as { correo: string };
    expect(body2.correo).toBe("ya_enviado_antes");
    expect(fetchMock).toHaveBeenCalledTimes(1); // sigue en 1 -- nunca se reenvía
  });

  it("sin ningún superadmin de plataforma registrado -- 'sin_destinatarios', nunca llama a Resend", async () => {
    const base = await buildTestDeps();
    const deps = conResendConfigurado(base.deps);
    const app = buildApp(deps);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });
    const body = (await res.json()) as { correo: string };
    expect(body.correo).toBe("sin_destinatarios");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET/POST /superadmin/resumen -- autorización y camino feliz", () => {
  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/resumen");
    expect(res.status).toBe(401);
  });

  it("un staff normal (no superadmin) -- 403 explícito", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/resumen", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("sin ningún resumen generado todavía -- lista vacía (nunca un error)", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/resumen", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumenes: unknown[] };
    expect(body.resumenes).toEqual([]);
  });

  it("'generar ahora' -- crea el resumen y aparece en el listado y en el detalle por fecha", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const generar = await app.request("/superadmin/resumen/generar", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(generar.status).toBe(200);
    const generarBody = (await generar.json()) as { fecha: string; generadoPor: string };

    const lista = await app.request("/superadmin/resumen", { headers: { authorization: `Bearer ${token}` } });
    const listaBody = (await lista.json()) as { resumenes: Array<{ fecha: string }> };
    expect(listaBody.resumenes.some((r) => r.fecha === generarBody.fecha)).toBe(true);

    const detalle = await app.request(`/superadmin/resumen/${generarBody.fecha}`, { headers: { authorization: `Bearer ${token}` } });
    expect(detalle.status).toBe(200);
    const detalleBody = (await detalle.json()) as { resumen: { fecha: string; generadoPor: string; narrativa: string } };
    expect(detalleBody.resumen.fecha).toBe(generarBody.fecha);
    expect(detalleBody.resumen.narrativa.length).toBeGreaterThan(0);
  });

  it("'generar ahora' es idempotente por fecha -- una segunda llamada la MISMA fecha actualiza, no duplica el listado", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const r1 = await app.request("/superadmin/resumen/generar", { method: "POST", headers, body: JSON.stringify({ fecha: "2026-02-01" }) });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/superadmin/resumen/generar", { method: "POST", headers, body: JSON.stringify({ fecha: "2026-02-01" }) });
    expect(r2.status).toBe(200);

    const lista = await app.request("/superadmin/resumen", { headers: { authorization: `Bearer ${token}` } });
    const listaBody = (await lista.json()) as { resumenes: Array<{ fecha: string }> };
    expect(listaBody.resumenes.filter((r) => r.fecha === "2026-02-01")).toHaveLength(1);
  });

  it("detalle de una fecha sin resumen -- 404 explícito", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/resumen/2099-01-01", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it("fecha con formato inválido -- 400 de validación", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/resumen/no-es-una-fecha", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });
});

// Hallazgo de auditoría a1 (BAJA, rubro B): en la base real SIN la migración
// `0015_superadmin_resumen_diario.sql` aplicada (el caso NORMAL de "código
// nuevo, base vieja" -- ver REGLA DURA de compatibilidad del repo), el
// UPSERT final (`core.upsert_daily_ops_summary`) no existe -- antes de este
// fix, el cron respondía 500 TODOS los días, después de gastar una llamada
// real de LLM (las 10 lecturas de fuente ya se tragaban su propio 42883
// dentro de `leer()`, pero el UPSERT corría sin try/catch).
describe("Resumen diario -- migración 0015 sin aplicar (SQLSTATE 42883), nunca un 500", () => {
  it("cron -- 200 honesto { ok:false, motivo:'migracion_pendiente' }, heartbeat sigue 'ok' (no es un fallo real)", async () => {
    const base = await buildTestDeps();
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).setMigracionPendiente(true);
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; motivo?: string };
    expect(body.ok).toBe(false);
    expect(body.motivo).toBe("migracion_pendiente");

    // El heartbeat NO debe quedar en 'error' -- `withHeartbeat` solo distingue
    // "el handler lanzó" de "el handler resolvió"; el handler resolvió con un
    // 200, así que el latido debe registrar 'ok'.
    const saludRepo = base.deps.saludRepo as import("@atiende/db").InMemorySaludRepository;
    const { superadminId } = await makeSuperadmin(base);
    saludRepo.addPlatformSuperadmin(superadminId); // registro propio de InMemorySaludRepository -- ver su comentario de cabecera
    const heartbeats = await saludRepo.listCronHeartbeatsForSuperadmin(superadminId);
    const latido = heartbeats.find((h) => h.cronName === CRON_PATH);
    expect(latido?.lastStatus).toBe("ok");
  });

  it("'generar ahora' -- 503 explícito (service_unavailable), nunca un 500 ni un 200 que finja éxito", async () => {
    const base = await buildTestDeps();
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).setMigracionPendiente(true);
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/resumen/generar", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
  });

  it("defensa en profundidad -- el sondeo pasa pero el UPSERT falla igual (42883) -> mismo resultado honesto, nunca un 500", async () => {
    const base = await buildTestDeps();
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).setUpsertMigracionPendiente(true);
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; motivo?: string };
    expect(body.ok).toBe(false);
    expect(body.motivo).toBe("migracion_pendiente");
  });

  it("un código de error que NO es 42883 en el SONDEO no se confunde con 'migración pendiente' -- el cron sigue adelante", async () => {
    const base = await buildTestDeps();
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).setFallando(true);
    const app = buildApp(base.deps);

    // `setFallando` tumba las 10 lecturas de fuente (se tragan a `null`, comportamiento
    // preexistente) Y también `listCronHeartbeatsForSystem` -- pero con un Error
    // genérico SIN `.code = "42883"`, así que el sondeo debe tratarlo como "sigue
    // adelante" (no como migración pendiente), y el cron debe completar con éxito
    // usando el "vacío honesto" ya existente para cada sección.
    //
    // NOTA (hallazgo no-bloqueante #2 de la auditoría a1): este test NO cubre la
    // rama de repropagación real (`if (!isUndefinedFunctionError(err)) throw err`
    // del UPSERT en agregador.ts) -- el título anterior de este test ("se
    // repropaga tal cual") afirmaba eso incorrectamente. Ese caso lo cubre el
    // siguiente test, que sí hace que el UPSERT lance un error genérico.
    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("un código de error que NO es 42883 en el UPSERT SÍ se repropaga tal cual -- el cron responde 500 real, nunca se confunde con 'migración pendiente'", async () => {
    const base = await buildTestDeps();
    const repo = base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository;
    // A diferencia de `setFallando`/`setUpsertMigracionPendiente` (ambos simulan
    // 42883), esto sobreescribe el método directamente con un Error genérico SIN
    // `.code = "42883"` -- el sondeo pasa normal, pero el UPSERT final lanza algo
    // que NO es "migración pendiente" y debe repropagarse tal cual (mismo patrón
    // que ya usa `superadmin-mantenimiento-cron.spec.ts` para el mismo caso).
    repo.upsertDailyOpsSummary = async () => {
      throw new Error("conexión perdida con Postgres");
    };
    const app = buildApp(base.deps);

    const res = await app.request(CRON_PATH, { method: "POST", headers: { "x-atiende-internal-secret": base.deps.env.internalSecret } });
    expect(res.status).toBe(500);
  });
});

// Hallazgo de auditoría a1 (BAJA, rubro D): el marcado atómico de
// `correo_enviado_en` se hace DESPUÉS de enviar a Resend (check-then-act,
// ver el comentario de cabecera de `enviarCorreoResumenDiarioSiCorresponde`
// para el porqué de NO invertir el orden) -- dos corridas concurrentes para
// la MISMA fecha podían mandar el correo dos veces. Arreglo: header
// `Idempotency-Key: resumen-diario/<fecha>` en el POST a Resend (soportado
// en `POST /emails`, ventana de deduplicación de 24h -- ver el cuerpo del
// PR para la cita completa de la documentación oficial de Resend). Estos
// tests verifican lo que SÍ puede probarse sin Postgres/Resend reales: que
// el código manda la clave correcta, determinista por fecha, en cada
// intento -- la deduplicación real la hace el servidor de Resend, fuera del
// alcance de una prueba unitaria.
describe("Correo del resumen -- header Idempotency-Key (hallazgo D)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dos corridas CONCURRENTES para la MISMA fecha mandan la MISMA Idempotency-Key -- Resend nunca reenvía bajo esa clave", async () => {
    const base = await buildTestDeps();
    const { email } = await makeSuperadmin(base);
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).seedPlatformSuperadminEmails([email]);
    const deps = conResendConfigurado(base.deps);

    const claves: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const idempotencyKey = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
      if (!idempotencyKey) throw new Error("fetch mock: falta el header Idempotency-Key en el POST a Resend.");
      claves.push(idempotencyKey);
      return new Response(JSON.stringify({ id: "resend-id" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fecha = "2026-03-05";
    const { agregados, narrativa } = await generarResumenOk(deps, fecha);

    // Simula la condición de carrera real: dos invocaciones que arrancan
    // "al mismo tiempo" para la MISMA fecha (p. ej. el cron real disparado
    // dos veces por un reintento de la plataforma serverless) -- ambas leen
    // `correoEnviadoEn === null` ANTES de que cualquiera termine de enviar
    // (el guard en memoria por sí solo no basta para evitar esto, que es
    // justo el hallazgo de la auditoría).
    await Promise.all([enviarCorreoResumenDiarioSiCorresponde(deps, fecha, agregados, narrativa), enviarCorreoResumenDiarioSiCorresponde(deps, fecha, agregados, narrativa)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(claves).toHaveLength(2);
    expect(claves[0]).toBe(`resumen-diario/${fecha}`);
    expect(claves[1]).toBe(claves[0]); // MISMA clave en ambas -- Resend deduplica del lado del servidor
  });

  it("fechas DISTINTAS -> Idempotency-Key DISTINTA -- nunca deduplica correos de días distintos", async () => {
    const base = await buildTestDeps();
    const { email } = await makeSuperadmin(base);
    (base.deps.resumenDiarioRepo as InMemoryResumenDiarioRepository).seedPlatformSuperadminEmails([email]);
    const deps = conResendConfigurado(base.deps);

    const claves: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const idempotencyKey = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
      if (!idempotencyKey) throw new Error("fetch mock: falta el header Idempotency-Key en el POST a Resend.");
      claves.push(idempotencyKey);
      return new Response(JSON.stringify({ id: "resend-id" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const gen1 = await generarResumenOk(deps, "2026-03-05");
    await enviarCorreoResumenDiarioSiCorresponde(deps, "2026-03-05", gen1.agregados, gen1.narrativa);
    const gen2 = await generarResumenOk(deps, "2026-03-06");
    await enviarCorreoResumenDiarioSiCorresponde(deps, "2026-03-06", gen2.agregados, gen2.narrativa);

    expect(claves).toEqual(["resumen-diario/2026-03-05", "resumen-diario/2026-03-06"]);
  });
});
