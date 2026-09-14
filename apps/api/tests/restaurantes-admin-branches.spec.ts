// Fase 5 restaurantes — HTTP end-to-end de admin-branches.ts (ficha de sucursal).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/admin/sucursales", () => {
  it("owner (org-wide) ve AMBAS sucursales", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: Array<{ propertyId: string }> };
    expect(body.branches.map((b) => b.propertyId).sort()).toEqual([ctx.propertyIdA, ctx.propertyIdB].sort());
  });

  it("staff acotado a sucursal A NUNCA ve la sucursal B en el listado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales`, authedGet(ctx.staff.staffSucursalA.token));
    const body = (await res.json()) as { branches: Array<{ propertyId: string }> };
    expect(body.branches.map((b) => b.propertyId)).toEqual([ctx.propertyIdA]);
  });

  it("repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });
});

describe("GET/PATCH /v1/restaurantes/:propertyId/admin/sucursales/:branchId", () => {
  it("owner edita teléfono/dirección real de la sucursal", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`,
      authedJson(ctx.staff.owner.token, { phone: "+529990000000", address: "Nueva dirección 123" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branch: { phone: string; address: string } };
    expect(body.branch.phone).toBe("+529990000000");
    expect(body.branch.address).toBe("Nueva dirección 123");

    const reread = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`, authedGet(ctx.staff.owner.token));
    expect(((await reread.json()) as { branch: { phone: string } }).branch.phone).toBe("+529990000000");
  });

  it("staff acotado a sucursal A NUNCA puede editar (ni leer) la sucursal B -- 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const read = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdB}`, authedGet(ctx.staff.staffSucursalA.token));
    expect(read.status).toBe(403);
    const write = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdB}`, authedJson(ctx.staff.staffSucursalA.token, { phone: "9999999999" }, "PATCH"));
    expect(write.status).toBe(403);
  });

  it("sucursal inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/00000000-0000-0000-0000-000000000000`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });

  it("lat/lng fuera de rango -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`, authedJson(ctx.staff.owner.token, { lat: 999 }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("slug inválido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`, authedJson(ctx.staff.owner.token, { slug: "Con Espacios" }, "PATCH"));
    expect(res.status).toBe(400);
  });
});
