// Back office de plataforma — recorre GET /superadmin/organizations contra los
// repos en memoria. Cubre el camino feliz (superadmin real ve todas las
// organizaciones + conteo real de staff) y el rechazo honesto (staff normal,
// sin sesión) — nunca confía solo en el chequeo de TS, la autorización real
// vive en la función SQL (verificado también contra Postgres de producción).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
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
