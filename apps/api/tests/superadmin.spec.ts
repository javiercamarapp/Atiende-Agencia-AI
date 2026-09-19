// Back office de plataforma — recorre GET /superadmin/organizations contra los
// repos en memoria. Cubre el camino feliz (superadmin real ve todas las
// organizaciones + conteo real de staff) y el rechazo honesto (staff normal,
// sin sesión) — nunca confía solo en el chequeo de TS, la autorización real
// vive en la función SQL (verificado también contra Postgres de producción).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryAuthzAuditRepository, InMemoryCoreRepository } from "@atiende/db";
import { signAccessToken } from "@atiende/core-auth";
import { buildApp } from "../src/app.ts";
import { buildTestDeps } from "./fixtures.ts";

describe("GET /superadmin/organizations", () => {
  it("un superadmin real ve todas las organizaciones (de cualquier vertical) con su conteo real de staff", async () => {
    const base = await buildTestDeps();
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;

    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);

    // buildTestDeps ya sembró una organización real (restaurantesRepo) — el
    // superadmin debe verla sin pertenecer a ella.
    const app = buildApp(base.deps);
    const token = await signAccessToken(
      { sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email: "superadmin@example.com" },
      base.deps.env.jwtSecret,
      base.deps.env.accessTokenTtlSeconds,
    );

    const res = await app.request("/superadmin/organizations", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizations: Array<{ id: string; staffCount: number }> };
    expect(body.organizations.some((o) => o.id === base.organizationId)).toBe(true);
    const org = body.organizations.find((o) => o.id === base.organizationId)!;
    expect(org.staffCount).toBeGreaterThanOrEqual(1);
  });

  it("un staff normal (no superadmin) recibe 403 explícito, nunca una lista vacía silenciosa", async () => {
    const base = await buildTestDeps();
    const token = await signAccessToken(
      { sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail },
      base.deps.env.jwtSecret,
      base.deps.env.accessTokenTtlSeconds,
    );

    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/organizations", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("sin token -- 401, mismo criterio que cualquier otra ruta autenticada", async () => {
    const base = await buildTestDeps();
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/organizations");
    expect(res.status).toBe(401);
  });
});

// Bitácora persistente de denegaciones (ver
// packages/db/migrations/0021_superadmin_authz_audit_log.sql) -- panel de
// oversight junto a la de impersonación. La autorización REAL
// (auth.uid()/core.platform_superadmin, UPDATE/DELETE rechazados) se verifica
// contra Postgres real en scripts/verify-superadmin-auditoria-denegaciones/;
// aquí se cubre el comportamiento equivalente en memoria: gateo, paginado con
// `hasMore`, y el estado "no disponible aún".
describe("GET /superadmin/authz-auditoria", () => {
  async function seedSuperadmin(base: Awaited<ReturnType<typeof buildTestDeps>>) {
    const coreRepo = base.deps.coreRepo as InMemoryCoreRepository;
    const superadminId = randomUUID();
    coreRepo.addStaff({ id: superadminId, email: "superadmin@example.com", passwordHash: null, fullName: "Super Admin", createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
    coreRepo.addPlatformSuperadmin(superadminId);
    const token = await signAccessToken({ sub: superadminId, org_id: "", vertical: "restaurantes", property_ids: null, email: "superadmin@example.com" }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
    return { superadminId, token };
  }

  it("un superadmin real ve las denegaciones ya registradas, más recientes primero", async () => {
    const base = await buildTestDeps();
    const repo = base.deps.authzAuditRepo({} as never) as InMemoryAuthzAuditRepository;
    await repo.recordDenial({ actorUserId: "staff-1", actorIp: "203.0.113.7", organizationId: null, action: "admin:access", route: "/superadmin/a", method: "POST", decision: "denied", reason: "no_membership", metadata: {}, occurredAtMs: Date.now() - 1000 });
    await repo.recordDenial({ actorUserId: "staff-2", actorIp: "203.0.113.8", organizationId: null, action: "admin:access", route: "/superadmin/b", method: "POST", decision: "denied", reason: "insufficient_role", metadata: {}, occurredAtMs: Date.now() });

    const { token } = await seedSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/authz-auditoria", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; hasMore: boolean; entries: Array<{ route: string }> };
    expect(body.available).toBe(true);
    expect(body.hasMore).toBe(false);
    expect(body.entries.map((e) => e.route)).toEqual(["/superadmin/b", "/superadmin/a"]);
  });

  it("paginado real -- limit/offset producen hasMore:true en la primera página", async () => {
    const base = await buildTestDeps();
    const repo = base.deps.authzAuditRepo({} as never) as InMemoryAuthzAuditRepository;
    for (let i = 0; i < 3; i += 1) {
      await repo.recordDenial({ actorUserId: `staff-${i}`, actorIp: null, organizationId: null, action: "admin:access", route: `/superadmin/${i}`, method: "POST", decision: "denied", reason: "no_membership", metadata: {}, occurredAtMs: Date.now() + i });
    }
    const { token } = await seedSuperadmin(base);
    const app = buildApp(base.deps);

    const res = await app.request("/superadmin/authz-auditoria?limit=2&offset=0", { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { entries: unknown[]; hasMore: boolean };
    expect(body.entries).toHaveLength(2);
    expect(body.hasMore).toBe(true);
  });

  it("un staff normal (no superadmin) recibe 403 explícito", async () => {
    const base = await buildTestDeps();
    const token = await signAccessToken({ sub: randomUUID(), org_id: base.organizationId, vertical: "restaurantes", property_ids: null, email: base.ownerEmail }, base.deps.env.jwtSecret, base.deps.env.accessTokenTtlSeconds);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/authz-auditoria", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  it("limit/offset inválidos -- 400, nunca 500", async () => {
    const base = await buildTestDeps();
    const { token } = await seedSuperadmin(base);
    const app = buildApp(base.deps);
    const res = await app.request("/superadmin/authz-auditoria?limit=abc", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
  });

  it("migración 0021 no aplicada -- available:false con lista vacía, nunca 500 ni una lista vacía indistinguible", async () => {
    const base = await buildTestDeps();
    const authzAuditRepoNoDisponible = {
      recordDenial: async () => ({ availability: "not_migrated" as const, id: null }),
      list: async () => ({ availability: "not_migrated" as const, entries: [], hasMore: false }),
    };
    const deps = { ...base.deps, authzAuditRepo: (_db: unknown) => authzAuditRepoNoDisponible } as typeof base.deps;
    const { token } = await seedSuperadmin({ ...base, deps });
    const app = buildApp(deps);
    const res = await app.request("/superadmin/authz-auditoria", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; entries: unknown[] };
    expect(body.available).toBe(false);
    expect(body.entries).toEqual([]);
  });
});
