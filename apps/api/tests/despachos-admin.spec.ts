// Fase 9: GET /v1/despachos/:orgSlug/admin/branches — mismo patrón de test exacto
// que licitaciones-admin.spec.ts/citas-admin.spec.ts para el mismo endpoint.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";

describe("GET /v1/despachos/:orgSlug/admin/branches", () => {
  it("un staff con membership real ve la property (singleton) de su organización", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/despachos/despacho-de-prueba/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.admin.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: readonly { propertyId: string; name: string }[] };
    expect(body.branches).toEqual([{ propertyId: ctx.propertyId, name: "Sede principal" }]);
  });

  it("un auditor (solo lectura) también puede resolver su property -- leer el propertyId no es una decisión", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/despachos/despacho-de-prueba/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.auditor.token}` } });
    expect(res.status).toBe(200);
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/despachos/despacho-de-prueba/admin/branches");
    expect(res.status).toBe(401);
  });

  it("responde 404 para un slug que no existe", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/despachos/no-existe/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.admin.token}` } });
    expect(res.status).toBe(404);
  });
});
