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

  it("owner guarda lat/lng y se leen de vuelta; se puede volver a null", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`;
    const res = await app.request(url, authedJson(ctx.staff.owner.token, { lat: 21.028, lng: -89.61 }, "PATCH"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: { lat: number; lng: number } }).branch).toMatchObject({ lat: 21.028, lng: -89.61 });
    const reread = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(((await reread.json()) as { branch: { lat: number; lng: number } }).branch).toMatchObject({ lat: 21.028, lng: -89.61 });
    const borrar = await app.request(url, authedJson(ctx.staff.owner.token, { lat: null, lng: null }, "PATCH"));
    expect(borrar.status).toBe(200);
    expect(((await borrar.json()) as { branch: { lat: null; lng: null } }).branch).toMatchObject({ lat: null, lng: null });
  });

  it("latitud entre 90 y 180 (no existe) -> 400; longitud -181 -> 400; texto -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`;
    for (const body of [{ lat: 91, lng: -89.6 }, { lat: -90.5, lng: -89.6 }, { lat: 21, lng: -181 }, { lat: 21, lng: 181 }, { lat: "21.03", lng: -89.6 }, { lat: 91 }, { lng: -181 }]) {
      const res = await app.request(url, authedJson(ctx.staff.owner.token, body, "PATCH"));
      expect(res.status).toBe(400);
    }
  });

  it("un solo eje en el cuerpo ({lat} solo, {lng} solo, {lat:null} solo) -> 400 y la sucursal no cambia", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`;
    for (const body of [{ lat: 21.03 }, { lng: -89.6 }, { lat: null }, { lng: null }]) {
      const res = await app.request(url, authedJson(ctx.staff.owner.token, body, "PATCH"));
      expect(res.status).toBe(400);
    }
    const reread = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { branch: { lat: number | null; lng: number | null } };
    expect(reread.branch.lat === null).toBe(reread.branch.lng === null);
  });

  it("un solo eje en null y el otro con valor en el mismo cuerpo -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`, authedJson(ctx.staff.owner.token, { lat: 21.03, lng: null }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("repartidor Y staff NO pueden poner coordenadas; la sucursal no cambia", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`;
    const antes = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { branch: { lat: number | null } };
    for (const token of [ctx.staff.repartidor.token, ctx.staff.staffSucursalA.token]) {
      const res = await app.request(url, authedJson(token, { lat: 21.03, lng: -89.6 }, "PATCH"));
      expect(res.status).toBe(403);
    }
    const despues = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { branch: { lat: number | null } };
    expect(despues.branch.lat).toBe(antes.branch.lat);
  });

  it("slug inválido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`, authedJson(ctx.staff.owner.token, { slug: "Con Espacios" }, "PATCH"));
    expect(res.status).toBe(400);
  });
});
