// PL-23 -- permisos por ACCION del panel de restaurantes (HTTP end-to-end, fixture compartido con admin-catalog/promotions/branches).
// staff (cajero/cocina): marca agotado/disponible pero no cambia precios, no toca promociones ni la sucursal; admin/owner si;
// repartidor nada; el staff acotado a la sucursal A no toca la B.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const PROMO = { code: "PERMISOS10", name: "10% permisos", type: "percentage", value: 10 };

async function contextoConProductoEnSucursalA() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const created = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Tacos al pastor", price: 30 }));
  const productId = ((await created.json()) as { product: { id: string } }).product.id;
  const activated = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`, authedJson(ctx.staff.owner.token, { price: 35, isAvailable: true }, "PATCH"));
  expect(activated.status).toBe(200);
  return { ctx, app, productId };
}

describe("PL-23 -- catalogo: disponibilidad (staff) vs precio (owner/admin)", () => {
  it("staff marca agotado y disponible (200) y el precio por sucursal NO cambia", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`;
    const agotado = await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { isAvailable: false }, "PATCH"));
    expect(agotado.status).toBe(200);
    expect(((await agotado.json()) as { branch: { price: number; isAvailable: boolean } }).branch).toMatchObject({ price: 35, isAvailable: false });
    const de_nuevo = await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { isAvailable: true }, "PATCH"));
    expect(de_nuevo.status).toBe(200);
    expect(((await de_nuevo.json()) as { branch: { price: number; isAvailable: boolean } }).branch).toMatchObject({ price: 35, isAvailable: true });
  });

  it("staff que manda precio (aunque sea el mismo) -> 403 con mensaje claro, y el precio queda igual", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`;
    for (const body of [{ price: 1 }, { price: 35, isAvailable: true }]) {
      const res = await app.request(url, authedJson(ctx.staff.staffSucursalA.token, body, "PATCH"));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("Solo el dueño o un administrador puede cambiar precios");
    }
    expect(await ctx.restaurantesRepo.getBranchProductState(ctx.propertyIdA, productId)).toMatchObject({ price: 35, isAvailable: true });
  });

  it("staff no puede dar de alta un producto en la sucursal (409) ni crear/editar productos y categorias (403)", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const otro = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Sin alta", price: 10 }));
    const otroId = ((await otro.json()) as { product: { id: string } }).product.id;
    const sinAlta = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${otroId}/branch-availability`, authedJson(ctx.staff.staffSucursalA.token, { isAvailable: true }, "PATCH"));
    expect(sinAlta.status).toBe(409);
    expect(await ctx.restaurantesRepo.getBranchProductState(ctx.propertyIdA, otroId)).toBeNull();

    const t = ctx.staff.staffSucursalA.token;
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;
    expect((await app.request(`${base}/products`, authedJson(t, { name: "Nuevo", price: 5 }))).status).toBe(403);
    expect((await app.request(`${base}/products/${productId}`, authedJson(t, { price: 1 }, "PATCH"))).status).toBe(403);
    expect((await app.request(`${base}/products/${productId}`, authedJson(t, { isAvailable: false }, "PATCH"))).status).toBe(403);
    expect((await app.request(`${base}/categories`, authedJson(t, { name: "Cat", slug: "cat" }))).status).toBe(403);
  });

  it("staff si ve el menu (GET productos y categorias)", async () => {
    const { ctx, app } = await contextoConProductoEnSucursalA();
    const t = ctx.staff.staffSucursalA.token;
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedGet(t))).status).toBe(200);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/categories`, authedGet(t))).status).toBe(200);
  });

  it("admin cambia precio por sucursal y producto; owner tambien", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    for (const actor of [ctx.staff.admin, ctx.staff.owner]) {
      const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`, authedJson(actor.token, { price: 41 }, "PATCH"));
      expect(res.status).toBe(200);
      const prod = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}`, authedJson(actor.token, { price: 33 }, "PATCH"));
      expect(prod.status).toBe(200);
    }
  });

  it("repartidor no hace nada del catalogo (403 en todo)", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const t = ctx.staff.repartidor.token;
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;
    expect((await app.request(`${base}/products`, authedGet(t))).status).toBe(403);
    expect((await app.request(`${base}/products/${productId}/branch-availability`, authedJson(t, { isAvailable: false }, "PATCH"))).status).toBe(403);
  });

  it("staff de la sucursal A no toca la B (403 por membresia) y la disponibilidad de A queda registrada en la bitacora", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const enB = await app.request(`/v1/restaurantes/${ctx.propertyIdB}/admin/products/${productId}/branch-availability`, authedJson(ctx.staff.staffSucursalA.token, { isAvailable: false }, "PATCH"));
    expect(enB.status).toBe(403);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`, authedJson(ctx.staff.staffSucursalA.token, { isAvailable: false }, "PATCH"));
    const auditoria = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    expect(JSON.stringify(await auditoria.json())).toContain("producto.disponibilidad_sucursal_actualizada");
  });

  it("staff de otra organizacion nunca llega (403)", async () => {
    const { ctx, app, productId } = await contextoConProductoEnSucursalA();
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${productId}/branch-availability`, authedJson(ctx.staff.otroOrgOwner.token, { isAvailable: false }, "PATCH"));
    expect(res.status).toBe(403);
  });
});

describe("PL-23 -- promociones: solo owner/admin", () => {
  it("staff no ve ni crea ni edita promociones (403); admin y owner si", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`;
    const t = ctx.staff.staffSucursalA.token;
    expect((await app.request(base, authedGet(t))).status).toBe(403);
    const intento = await app.request(base, authedJson(t, PROMO));
    expect(intento.status).toBe(403);
    expect(JSON.stringify(await intento.json())).toContain("Solo el dueño o un administrador");

    const creada = await app.request(base, authedJson(ctx.staff.admin.token, PROMO));
    expect(creada.status).toBe(201);
    const id = ((await creada.json()) as { promotion: { id: string } }).promotion.id;
    expect((await app.request(`${base}/${id}`, authedJson(t, { isActive: false }, "PATCH"))).status).toBe(403);
    expect((await app.request(`${base}/${id}`, authedJson(ctx.staff.owner.token, { isActive: false }, "PATCH"))).status).toBe(200);
    expect((await app.request(base, authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(base, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
  });
});

describe("PL-23 -- sucursal: staff ve, solo owner/admin edita", () => {
  it("staff lee su sucursal (200) pero editarla -> 403; admin si, y queda en bitacora", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdA}`;
    expect((await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(200);
    const intento = await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { address: "Calle falsa 1" }, "PATCH"));
    expect(intento.status).toBe(403);
    expect(JSON.stringify(await intento.json())).toContain("Solo el dueño o un administrador puede editar los datos de la sucursal");

    const ok = await app.request(url, authedJson(ctx.staff.admin.token, { address: "Calle real 2" }, "PATCH"));
    expect(ok.status).toBe(200);
    const auditoria = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria`, authedGet(ctx.staff.owner.token));
    expect(JSON.stringify(await auditoria.json())).toContain("sucursal.actualizada");
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { address: "x" }, "PATCH"))).status).toBe(403);
  });

  it("staff acotado a A no lee ni edita la sucursal B", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/sucursales/${ctx.propertyIdB}`;
    expect((await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { address: "x" }, "PATCH"))).status).toBe(403);
  });
});
