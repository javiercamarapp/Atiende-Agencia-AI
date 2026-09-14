// Fase 7 pieza 1: GET /v1/licitaciones/:orgSlug/admin/branches — mismo patrón de
// test exacto que citas-admin.spec.ts para el mismo endpoint de citas.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext } from "./licitaciones-fixtures.ts";

describe("GET /v1/licitaciones/:orgSlug/admin/branches", () => {
  it("un staff con membership real ve la property (singleton) de su organización", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: readonly { propertyId: string; name: string }[] };
    expect(body.branches).toEqual([{ propertyId: ctx.propertyId, name: "Sede principal" }]);
  });

  it("un viewer (solo lectura) también puede resolver su property -- leer el propertyId no es una decisión", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.viewer.token}` } });
    expect(res.status).toBe(200);
  });

  it("rechaza sin JWT (401)", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/empresa-de-prueba/admin/branches");
    expect(res.status).toBe(401);
  });

  it("responde 404 para un slug que no existe", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/licitaciones/no-existe/admin/branches", { headers: { authorization: `Bearer ${ctx.staff.owner.token}` } });
    expect(res.status).toBe(404);
  });
});
