// Back office de plataforma -- "Salud operativa". Recorre las rutas contra
// los repos en memoria: 403 explícito para un staff normal, y el camino
// feliz con datos reales sembrados en `InMemorySaludRepository`/
// `InMemoryLlmUsageRepository` -- mismo criterio que
// `superadmin-llm-usage.spec.ts`/`superadmin-facturacion.spec.ts` (la
// autorización real vive en la función SQL; aquí se verifica el
// comportamiento equivalente en memoria).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository, InMemoryLlmUsageRepository, InMemorySaludRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

async function makeSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<{ token: string; superadminId: string }> {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
  const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
  const superadminId = randomUUID();
  coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
  saludRepo.addPlatformSuperadmin(superadminId);
  llmUsageRepo.addPlatformSuperadmin(superadminId);
  const token = await signAccessToken(
    { sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email: "superadmin@example.com" },
    base.deps.env.jwtSecret,
    base.deps.env.accessTokenTtlSeconds,
  );
  return { token, superadminId };
}

async function staffToken(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<string> {
  return signAccessToken(
    { sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail },
    base.deps.env.jwtSecret,
    base.deps.env.accessTokenTtlSeconds,
  );
}

describe("GET /superadmin/salud", () => {
  it("un staff normal (no superadmin) recibe 403 explícito", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud");
    expect(res.status).toBe(401);
  });

  it("entorno recién desplegado (ningún cron corrió todavía) -- todos los crons declarados aparecen 'sin_latido', nunca un error", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud/crons", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { crons: Array<{ cronName: string; estado: string; heartbeat: unknown }> };
    expect(body.crons.length).toBe(17);
    for (const cron of body.crons) {
      expect(cron.estado).toBe("sin_latido");
      expect(cron.heartbeat).toBeNull();
    }
  });

  it("un latido real registrado hace que ese cron aparezca 'ok' en /superadmin/salud/crons", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
    const ahora = new Date();
    await saludRepo.recordCronHeartbeat({
      cronName: "/internal/hoteles/night-audit",
      status: "ok",
      error: null,
      startedAt: ahora.toISOString(),
      finishedAt: ahora.toISOString(),
      durationMs: 1200,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud/crons", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { crons: Array<{ cronName: string; estado: string }> };
    const cron = body.crons.find((c) => c.cronName === "/internal/hoteles/night-audit");
    expect(cron?.estado).toBe("ok");
  });

  it("un cron con último estado 'error' aparece como 'error' y genera una alerta 'critica' en el resumen", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
    const ahora = new Date();
    await saludRepo.recordCronHeartbeat({
      cronName: "/internal/whatsapp/dispatch",
      status: "error",
      error: "WHATSAPP_ACCESS_TOKEN inválido",
      startedAt: ahora.toISOString(),
      finishedAt: ahora.toISOString(),
      durationMs: 300,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { alertas: Array<{ severidad: string; titulo: string }> };
    expect(body.alertas.some((a) => a.severidad === "critica" && a.titulo.includes("/internal/whatsapp/dispatch"))).toBe(true);
  });

  it("colas con mensajes muertos generan una alerta real en /superadmin/salud, y /superadmin/salud/colas expone el detalle", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
    saludRepo.seedOutboxHealth([
      { queueName: "hoteles", pendingCount: 0, processingCount: 0, sentCount: 10, failedCount: 0, deadCount: 2, oldestPendingSeconds: null, lastSentAt: null },
    ]);

    const app = buildApp(base.deps);
    const resSalud = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${token}` } });
    const bodySalud = (await resSalud.json()) as { alertas: Array<{ titulo: string }> };
    expect(bodySalud.alertas.some((a) => a.titulo.includes("hoteles") && a.titulo.includes("muerto"))).toBe(true);

    const resColas = await app.request("/superadmin/salud/colas", { headers: { authorization: `Bearer ${token}` } });
    const bodyColas = (await resColas.json()) as { colas: Array<{ queueName: string; deadCount: number }> };
    expect(bodyColas.colas).toEqual([expect.objectContaining({ queueName: "hoteles", deadCount: 2 })]);
  });

  it("una fuente de licitaciones configurada con estado distinto de 'ok' aparece en /superadmin/salud/licitaciones-fuentes y genera alerta", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const saludRepo = base.deps.saludRepo as InMemorySaludRepository;
    saludRepo.seedLicitacionesFuenteRuns([
      { organizationId: "org-1", organizationName: "Org 1", source: "compras_mx_historico", state: "captcha_detected", finishedAt: new Date().toISOString(), message: "403 Access Denied" },
    ]);

    const app = buildApp(base.deps);
    const resFuentes = await app.request("/superadmin/salud/licitaciones-fuentes", { headers: { authorization: `Bearer ${token}` } });
    const bodyFuentes = (await resFuentes.json()) as { fuentes: Array<{ source: string; state: string }> };
    expect(bodyFuentes.fuentes).toHaveLength(1);

    const resSalud = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${token}` } });
    const bodySalud = (await resSalud.json()) as { alertas: Array<{ severidad: string; titulo: string }> };
    expect(bodySalud.alertas.some((a) => a.severidad === "media" && a.titulo.includes("compras_mx_historico"))).toBe(true);
  });

  it("gasto de LLM por encima del umbral de alerta de plataforma genera una alerta real, reutilizando el mismo tope que /superadmin/gasto-api", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    await llmUsageRepo.setPlatformMonthlyCapForSuperadmin(superadminId, 100_000, 80);
    await llmUsageRepo.recordUsage({
      organizationId: base.organizationId,
      vertical: "restaurantes",
      role: "restaurantes:whatsapp_agent",
      providerId: "anthropic",
      model: "claude-x",
      lane: "interactive",
      tokensIn: 1,
      tokensOut: 1,
      costMicroUsd: 90_000,
      fallbackUsed: false,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { alertas: Array<{ titulo: string }> };
    expect(body.alertas.some((a) => a.titulo.toLowerCase().includes("gasto de api de llm"))).toBe(true);
  });

  it("todo sano -- sin alertas, semáforo verde implícito (arreglo vacío)", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/salud", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { alertas: unknown[] };
    expect(body.alertas).toEqual([]);
  });
});

describe("GET /superadmin/salud/crons|colas|licitaciones-fuentes", () => {
  it("un staff normal recibe 403 en las 3 rutas de detalle", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const token = await staffToken(base);
    for (const path of ["/superadmin/salud/crons", "/superadmin/salud/colas", "/superadmin/salud/licitaciones-fuentes"]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(403);
    }
  });
});
