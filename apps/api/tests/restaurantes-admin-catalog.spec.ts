// Fase 5 restaurantes — HTTP end-to-end de admin-catalog.ts (categorías/productos/
// disponibilidad por sucursal). Reusa el mismo fixture (org/2 sucursales/staff con
// roles reales) que restaurantes-admin-kpis.spec.ts (Fase 3) — es exactamente el
// mismo modelo de autorización (MANAGER_ROLES + membership por sucursal), así que
// reescribirlo sería duplicar setup ya probado.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("Categorías — POST/PATCH /v1/restaurantes/:propertyId/admin/categories", () => {
  it("exige un token (401)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, { method: "POST", body: JSON.stringify({ name: "Postres", slug: "postres" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });

  it("repartidor (fuera de MANAGER_ROLES) -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedJson(ctx.staff.repartidor.token, { name: "Postres", slug: "postres" }));
    expect(res.status).toBe(403);
  });

  it("owner crea una categoría real, luego la edita", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedJson(ctx.staff.owner.token, { name: "Postres", slug: "postres" }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { category: { id: string; name: string; slug: string } };
    expect(createdBody.category.name).toBe("Postres");

    const listed = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedGet(ctx.staff.owner.token));
    const listedBody = (await listed.json()) as { categories: Array<{ id: string }> };
    expect(listedBody.categories.some((c) => c.id === createdBody.category.id)).toBe(true);

    const updated = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/categories/${createdBody.category.id}`,
      authedJson(ctx.staff.owner.token, { name: "Postres y helados" }, "PATCH"),
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { category: { name: string } }).category.name).toBe("Postres y helados");
  });

  it("name vacío -> 400 de validación", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedJson(ctx.staff.owner.token, { name: "", slug: "vacio" }));
    expect(res.status).toBe(400);
  });

  it("slug con mayúsculas/espacios -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedJson(ctx.staff.owner.token, { name: "Postres", slug: "Postres Ricos" }));
    expect(res.status).toBe(400);
  });

  it("editar una categoría inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories/00000000-0000-0000-0000-000000000000`, authedJson(ctx.staff.owner.token, { name: "x" }, "PATCH"));
    expect(res.status).toBe(404);
  });
});

describe("Productos — CRUD + disponibilidad por sucursal", () => {
  it("crea un producto y lo activa en la sucursal A -- aparece con branch.price/isAvailable, y con precio distinto en B (nunca dado de alta ahí)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Horchata", price: 35 }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { product: { id: string; branch: unknown } };
    expect(createdBody.product.branch).toBeNull();
    const productId = createdBody.product.id;

    const activated = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`,
      authedJson(ctx.staff.owner.token, { price: 40, isAvailable: true }, "PATCH"),
    );
    expect(activated.status).toBe(200);
    expect(((await activated.json()) as { branch: { price: number; isAvailable: boolean } }).branch).toEqual({ propertyId: ctx.propertyIdA, productId, price: 40, isAvailable: true });

    const listA = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedGet(ctx.staff.owner.token))).json()) as {
      products: Array<{ id: string; branch: { price: number; isAvailable: boolean } | null }>;
    };
    const rowA = listA.products.find((p) => p.id === productId);
    expect(rowA?.branch).toEqual({ propertyId: ctx.propertyIdA, productId, price: 40, isAvailable: true });

    const listB = (await (await app.request(`/v1/restaurantes/${ctx.propertyIdB}/admin/products`, authedGet(ctx.staff.owner.token))).json()) as {
      products: Array<{ id: string; branch: unknown }>;
    };
    const rowB = listB.products.find((p) => p.id === productId);
    expect(rowB?.branch).toBeNull(); // nunca se asume disponible en B solo porque lo está en A
  });

  it("price negativo -> 400 (nunca se acepta un precio inválido)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "x", price: -5 }));
    expect(res.status).toBe(400);
  });

  it("activar disponibilidad de un producto inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/products/00000000-0000-0000-0000-000000000000/branch-availability`,
      authedJson(ctx.staff.owner.token, { isAvailable: true }, "PATCH"),
    );
    expect(res.status).toBe(404);
  });

  it("staff acotado a sucursal A no puede activar disponibilidad en B (403, requirePropertyMembership)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "x", price: 10 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdB}/admin/products/${productId}/branch-availability`,
      authedJson(ctx.staff.staffSucursalA.token, { isAvailable: true }, "PATCH"),
    );
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización nunca ve/edita el catálogo de esta (aislamiento cross-tenant)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("edita nombre/precio de un producto existente", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "x", price: 10 }));
    const productId = ((await created.json()) as { product: { id: string } }).product.id;

    const updated = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(ctx.staff.owner.token, { name: "y", price: 20 }, "PATCH"));
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { product: { name: string; price: number } };
    expect(body.product).toMatchObject({ name: "y", price: 20 });
  });
});
