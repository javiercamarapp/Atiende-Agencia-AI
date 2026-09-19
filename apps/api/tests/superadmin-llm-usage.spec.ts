// Control de gasto de API de LLM — back office de plataforma. Recorre las
// rutas contra los repos en memoria: camino feliz para un superadmin real
// (desglose por organización/proveedor-modelo, % de tope usado, escritura de
// tope) y el rechazo honesto para un staff normal — mismo criterio que
// `superadmin.spec.ts` (la autorización real vive en la función SQL, aquí se
// verifica el comportamiento equivalente en memoria).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository, InMemoryLlmUsageRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

async function makeSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>): Promise<{ token: string; superadminId: string }> {
  const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
  const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
  const superadminId = randomUUID();
  coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addPlatformSuperadmin(superadminId);
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

describe("GET /superadmin/gasto-api/resumen", () => {
  it("un staff normal (no superadmin) recibe 403 explícito", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/resumen", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/resumen");
    expect(res.status).toBe(401);
  });

  it("sin ningún uso registrado todavía, responde ceros reales -- nunca datos falsos", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/resumen", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { tokensIn: number; tokensOut: number; costMicroUsd: number; callCount: number }; platformBudget: { monthlyCapMicroUsd: number } };
    expect(body.usage).toEqual({ tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 });
    expect(body.platformBudget.monthlyCapMicroUsd).toBeGreaterThan(0);
  });

  it("un rango de fechas mal formado -- 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/resumen?from=no-es-fecha", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it("con uso real registrado hoy, el resumen del rango por defecto (últimos 30 días) lo incluye", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    await llmUsageRepo.recordUsage({
      organizationId: base.organizationId,
      vertical: "restaurantes",
      role: "restaurantes:whatsapp_agent",
      providerId: "anthropic",
      model: "claude-x",
      lane: "interactive",
      tokensIn: 100,
      tokensOut: 50,
      costMicroUsd: 12_000,
      fallbackUsed: false,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/resumen", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: { tokensIn: number; costMicroUsd: number; callCount: number } };
    expect(body.usage.tokensIn).toBe(100);
    expect(body.usage.costMicroUsd).toBe(12_000);
    expect(body.usage.callCount).toBe(1);
  });
});

describe("GET /superadmin/gasto-api/organizaciones", () => {
  it("lista la organización sembrada con % de tope usado calculado sobre el gasto real del mes", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    await llmUsageRepo.setOrgMonthlyCapForSuperadmin(superadminId, base.organizationId, 100_000, 80);
    await llmUsageRepo.recordUsage({
      organizationId: base.organizationId,
      vertical: "restaurantes",
      role: "restaurantes:whatsapp_agent",
      providerId: "openai",
      model: "gpt-x",
      lane: "interactive",
      tokensIn: 10,
      tokensOut: 10,
      costMicroUsd: 50_000,
      fallbackUsed: true,
    });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/organizaciones", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizaciones: Array<{ organizationId: string; costMicroUsd: number; monthlyCapMicroUsd: number; pctTopeUsado: number }> };
    const org = body.organizaciones.find((o) => o.organizationId === base.organizationId);
    expect(org).toBeDefined();
    expect(org!.costMicroUsd).toBe(50_000);
    expect(org!.monthlyCapMicroUsd).toBe(100_000);
    expect(org!.pctTopeUsado).toBe(50);
  });

  it("un staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/organizaciones", { headers: { authorization: `Bearer ${await staffToken(base)}` } });
    expect(res.status).toBe(403);
  });
});

describe("GET /superadmin/gasto-api/desglose", () => {
  it("agrupa por vertical + proveedor + modelo", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    await llmUsageRepo.recordUsage({ organizationId: base.organizationId, vertical: "restaurantes", role: "restaurantes:whatsapp_agent", providerId: "anthropic", model: "claude-x", lane: "interactive", tokensIn: 5, tokensOut: 5, costMicroUsd: 1000, fallbackUsed: false });
    await llmUsageRepo.recordUsage({ organizationId: base.organizationId, vertical: "restaurantes", role: "restaurantes:whatsapp_agent", providerId: "anthropic", model: "claude-x", lane: "interactive", tokensIn: 5, tokensOut: 5, costMicroUsd: 1000, fallbackUsed: false });

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/desglose", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { desglose: Array<{ providerId: string; model: string; costMicroUsd: number; callCount: number }> };
    expect(body.desglose).toHaveLength(1);
    expect(body.desglose[0]).toMatchObject({ providerId: "anthropic", model: "claude-x", costMicroUsd: 2000, callCount: 2 });
  });
});

describe("PUT /superadmin/gasto-api/organizaciones/:id/tope", () => {
  it("un superadmin real edita el tope y el efecto se ve reflejado de inmediato", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const res = await app.request(`/superadmin/gasto-api/organizaciones/${base.organizationId}/tope`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 250, alertThresholdPct: 90 }),
    });
    expect(res.status).toBe(200);

    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    const rows = await llmUsageRepo.listUsageByOrganizationForSuperadmin(superadminId, "2000-01-01", "2999-01-01");
    const org = rows.find((r) => r.organizationId === base.organizationId)!;
    expect(org.monthlyCapMicroUsd).toBe(250_000_000);
    expect(org.alertThresholdPct).toBe(90);
  });

  it("un monto no positivo -- 400", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request(`/superadmin/gasto-api/organizaciones/${base.organizationId}/tope`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("una organización inexistente -- 404", async () => {
    const base = await buildTestDeps();
    const { token } = await makeSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request(`/superadmin/gasto-api/organizaciones/${randomUUID()}/tope`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 50 }),
    });
    expect(res.status).toBe(404);
  });

  it("un staff normal recibe 403 (nunca puede editar el tope de nadie)", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request(`/superadmin/gasto-api/organizaciones/${base.organizationId}/tope`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await staffToken(base)}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 50 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PUT /superadmin/gasto-api/plataforma/tope", () => {
  it("un superadmin real edita el tope global de plataforma", async () => {
    const base = await buildTestDeps();
    const { token, superadminId } = await makeSuperadmin(base);
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/gasto-api/plataforma/tope", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 5000 }),
    });
    expect(res.status).toBe(200);

    const llmUsageRepo = base.deps.llmUsageRepo as InMemoryLlmUsageRepository;
    const platformBudget = await llmUsageRepo.getPlatformBudgetForSuperadmin(superadminId);
    expect(platformBudget.monthlyCapMicroUsd).toBe(5_000_000_000);
  });

  it("un staff normal recibe 403", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/gasto-api/plataforma/tope", {
      method: "PUT",
      headers: { authorization: `Bearer ${await staffToken(base)}`, "content-type": "application/json" },
      body: JSON.stringify({ monthlyCapUsd: 5000 }),
    });
    expect(res.status).toBe(403);
  });
});
