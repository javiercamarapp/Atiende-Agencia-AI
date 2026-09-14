// Fase 11 restaurantes — HTTP end-to-end de admin-promotions.ts (CRUD real de
// promociones/marketing). Mismo fixture (org/2 sucursales/staff con roles reales)
// que restaurantes-admin-catalog.spec.ts -- mismo modelo de autorización
// (MANAGER_ROLES + membership por sucursal), reusado a propósito.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("POST/PATCH /v1/restaurantes/:propertyId/admin/promotions", () => {
  it("exige un token (401)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, {
      method: "POST",
      body: JSON.stringify({ code: "BIENVENIDA10", name: "Bienvenida", type: "percentage", value: 10 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("repartidor (fuera de MANAGER_ROLES) -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.repartidor.token, { code: "BIENVENIDA10", name: "Bienvenida", type: "percentage", value: 10 }),
    );
    expect(res.status).toBe(403);
  });

  it("owner crea un código porcentual real, luego lo edita (desactivar = mismo PATCH)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.owner.token, { code: "bienvenida10", name: "10% de bienvenida", type: "percentage", value: 10, maxUses: 100 }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { promotion: { id: string; code: string; timesUsed: number; isActive: boolean } };
    expect(createdBody.promotion.code).toBe("BIENVENIDA10"); // normalizado a mayúsculas
    expect(createdBody.promotion.timesUsed).toBe(0);
    expect(createdBody.promotion.isActive).toBe(true);

    const listed = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedGet(ctx.staff.owner.token));
    const listedBody = (await listed.json()) as { promotions: Array<{ id: string }> };
    expect(listedBody.promotions.some((p) => p.id === createdBody.promotion.id)).toBe(true);

    // "Desactivar" es el mismo PATCH genérico con isActive:false -- nunca una ruta separada.
    const deactivated = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/${createdBody.promotion.id}`,
      authedJson(ctx.staff.owner.token, { isActive: false }, "PATCH"),
    );
    expect(deactivated.status).toBe(200);
    expect(((await deactivated.json()) as { promotion: { isActive: boolean } }).promotion.isActive).toBe(false);
  });

  it("crea un código de monto fijo con vigencia por fecha/hora/día de semana", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.owner.token, {
        code: "COMIDA-CORRIDA",
        name: "Comida corrida entre semana",
        type: "fixed",
        value: 30,
        minOrderTotal: 150,
        daysOfWeek: [1, 2, 3, 4, 5],
        startTime: "13:00",
        endTime: "17:00",
        maxUses: 500,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { promotion: { daysOfWeek: number[]; startTime: string; endTime: string; minOrderTotal: number } };
    expect(body.promotion.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(body.promotion.startTime).toBe("13:00");
    expect(body.promotion.endTime).toBe("17:00");
    expect(body.promotion.minOrderTotal).toBe(150);
  });

  it("value>100 en un código porcentual -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.owner.token, { code: "IMPOSIBLE", name: "x", type: "percentage", value: 150 }),
    );
    expect(res.status).toBe(400);
  });

  it("código con formato inválido (minúsculas/espacios se normalizan, pero símbolos no) -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`,
      authedJson(ctx.staff.owner.token, { code: "10% OFF!", name: "x", type: "percentage", value: 10 }),
    );
    expect(res.status).toBe(400);
  });

  it("código duplicado dentro de la misma organización -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "DUP", name: "x", type: "fixed", value: 10 }));
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "dup", name: "y", type: "fixed", value: 20 }));
    expect(res.status).toBe(400);
  });

  it("editar una promoción inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions/00000000-0000-0000-0000-000000000000`,
      authedJson(ctx.staff.owner.token, { name: "x" }, "PATCH"),
    );
    expect(res.status).toBe(404);
  });

  it("staff de OTRA organización nunca ve ni edita una promoción ajena (aislamiento cross-tenant)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.owner.token, { code: "PROPIA", name: "x", type: "fixed", value: 10 }));
    const createdBody = (await created.json()) as { promotion: { id: string } };

    const list = await app.request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/promotions`, authedGet(ctx.staff.otroOrgOwner.token));
    const listBody = (await list.json()) as { promotions: Array<{ id: string }> };
    expect(listBody.promotions.some((p) => p.id === createdBody.promotion.id)).toBe(false);

    const patch = await app.request(
      `/v1/restaurantes/${ctx.otherPropertyId}/admin/promotions/${createdBody.promotion.id}`,
      authedJson(ctx.staff.otroOrgOwner.token, { name: "hackeado" }, "PATCH"),
    );
    expect(patch.status).toBe(404);
  });
});
