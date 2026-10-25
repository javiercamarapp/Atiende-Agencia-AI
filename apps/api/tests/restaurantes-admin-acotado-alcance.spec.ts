// Admin ACOTADO (membresia con `property_ids`): catalogo/precios y configuracion del agente/canales son de toda la organizacion, asi que
// un admin que gobierna solo algunas sucursales recibe 403 (no puede tocar el precio de las 8). Lo que es por sucursal sigue funcionando.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("admin acotado: escrituras de toda la organizacion", () => {
  it("catalogo: crear/editar categoria y producto -> 403 al acotado, 2xx al admin general y al dueño", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;

    const catAcotado = await app.request(`${base}/categories`, authedJson(ctx.staff.adminSucursalA.token, { name: "Postres", slug: "postres" }));
    expect(catAcotado.status).toBe(403);
    const prodAcotado = await app.request(`${base}/products`, authedJson(ctx.staff.adminSucursalA.token, { name: "Agua", price: 35 }));
    expect(prodAcotado.status).toBe(403);

    const prod = await app.request(`${base}/products`, authedJson(ctx.staff.admin.token, { name: "Agua de Horchata", price: 35 }));
    expect(prod.status).toBeLessThan(300);
    const { product } = (await prod.json()) as { product: { id: string } };
    expect((await app.request(`${base}/categories`, authedJson(ctx.staff.owner.token, { name: "Postres", slug: "postres" }))).status).toBeLessThan(300);

    const cambioPrecio = await app.request(`${base}/products/${product.id}`, authedJson(ctx.staff.adminSucursalA.token, { price: 1 }, "PATCH"));
    expect(cambioPrecio.status).toBe(403);
    // El precio sigue intacto.
    expect((await ctx.restaurantesRepo.findProduct(ctx.organizationId, product.id))?.price).toBe(35);
  });

  it("precio EN su sucursal sigue permitido; en una sucursal fuera de su alcance -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const prod = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua", price: 35 }));
    const { product } = (await prod.json()) as { product: { id: string } };
    const propio = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products/${product.id}/branch-availability`, authedJson(ctx.staff.adminSucursalA.token, { price: 40, isAvailable: true }, "PATCH"));
    expect(propio.status).toBe(200);
    const ajeno = await app.request(`/v1/restaurantes/${ctx.propertyIdB}/admin/products/${product.id}/branch-availability`, authedJson(ctx.staff.adminSucursalA.token, { price: 1, isAvailable: true }, "PATCH"));
    expect(ajeno.status).toBe(403);
  });

  it("promociones de toda la organizacion -> 403 al acotado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/promotions`, authedJson(ctx.staff.adminSucursalA.token, { code: "TODO10", description: "10%", discountType: "percentage", discountValue: 10 }));
    expect(res.status).toBe(403);
  });

  it("configuracion de canales (WhatsApp) y zonas -> 403 al acotado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const wa = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedJson(ctx.staff.adminSucursalA.token, { phoneNumberId: "123456789" }, "PUT"));
    expect(wa.status).toBe(403);
    const waGeneral = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/whatsapp`, authedJson(ctx.staff.admin.token, { phoneNumberId: "123456789" }, "PUT"));
    expect(waGeneral.status).toBeLessThan(300);
  });
});
