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
import type { AppDeps } from "../src/deps.ts";

const CRON_PATH = "/internal/superadmin/resumen-diario";

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
