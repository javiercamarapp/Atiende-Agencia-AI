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

  // Escrituras que cambian a TODA la organizacion: [metodo, ruta bajo /admin, cuerpo]. El cuerpo puede no ser valido para el handler: el
  // control de alcance corre antes y lo que se verifica es 403 (acotado) contra "no 403" (admin general y dueño).
  type Metodo = "POST" | "PUT" | "PATCH" | "DELETE";
  const ORG_WIDE: ReadonlyArray<readonly [string, Metodo, string, unknown]> = [
    ["zonas POST", "POST", "/config/zonas", { name: "Centro", fee: 30 }],
    ["zonas DELETE", "DELETE", "/config/zonas/00000000-0000-4000-8000-000000000001", undefined],
    ["zona horaria", "PATCH", "/config/zona-horaria", { timezone: "America/Merida" }],
    ["agente WhatsApp (alcance organizacion)", "PUT", "/config/agente-whatsapp", { alcance: "organizacion" }],
    ["restablecer agente", "POST", "/config/agente-whatsapp/restablecer", { alcance: "organizacion" }],
    ["marketing config", "PUT", "/marketing/config", { activo: true }],
    ["marketing decidir", "POST", "/marketing/campanas/00000000-0000-4000-8000-000000000001/decidir", { accion: "aprobar" }],
    ["ajustes del agente", "PUT", "/agente/ajustes", {}],
    ["alertas al dueño (umbrales)", "PUT", "/alertas-duenio", { silencioActivo: true, silencioVentanaMin: 60, silencioHistoricoMin: 10 }],
    ["resumen: configuracion de la organizacion", "PUT", "/resumen/config", { activo: true }],
    ["avisos: preferencias de OTRA persona", "PUT", "/avisos/preferencias", { tipo: "restaurantes.pedido.nuevo", enabled: true, userId: "00000000-0000-4000-8000-0000000000aa" }],
    ["marca «no a domicilio» de producto", "PUT", "/config/no-domicilio/productos/00000000-0000-4000-8000-000000000001", { noDomicilio: true }],
    ["SoftRestaurant modo", "PUT", "/softrestaurant/config", { modo: "apagado" }],
  ];
  for (const [nombre, metodo, ruta, cuerpo] of ORG_WIDE) {
    it(`${nombre}: 403 al admin acotado; el admin general y el dueño no reciben 403`, async () => {
      const ctx = await buildRestaurantesKpiTestContext(buildApp);
      const app = buildApp(ctx.deps);
      const url = `/v1/restaurantes/${ctx.propertyIdA}/admin${ruta}`;
      const llamar = (token: string) => app.request(url, cuerpo === undefined ? { method: metodo, headers: { authorization: `Bearer ${token}` } } : authedJson(token, cuerpo, metodo));
      expect((await llamar(ctx.staff.adminSucursalA.token)).status).toBe(403);
      expect((await llamar(ctx.staff.admin.token)).status).not.toBe(403);
      expect((await llamar(ctx.staff.owner.token)).status).not.toBe(403);
    });
  }

  it("agente WhatsApp con alcance de UNA sucursal: el acotado no recibe 403 en la suya", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/config/agente-whatsapp`, authedJson(ctx.staff.adminSucursalA.token, { alcance: "sucursal" }, "PUT"));
    expect(res.status).not.toBe(403);
  });

  // Estas son POR SUCURSAL (ya validan el alcance): propia permitida, ajena 403.
  for (const [nombre, metodo, sufijo, cuerpo] of [
    ["secreto de voz", "POST", "voz/secreto", undefined],
    ["interruptor del agente", "PUT", "agente-whatsapp-interruptor", { activo: true }],
  ] as const) {
    it(`${nombre} por sucursal: la propia no da 403; una ajena si`, async () => {
      const ctx = await buildRestaurantesKpiTestContext(buildApp);
      const app = buildApp(ctx.deps);
      const ruta = (branch: string) => (sufijo === "voz/secreto" ? `/config/sucursales/${branch}/voz/secreto` : `/config/sucursales/${branch}/agente-whatsapp`);
      const llamar = (branch: string) => {
        const url = `/v1/restaurantes/${ctx.propertyIdA}/admin${ruta(branch)}`;
        return app.request(url, cuerpo === undefined ? { method: metodo, headers: { authorization: `Bearer ${ctx.staff.adminSucursalA.token}` } } : authedJson(ctx.staff.adminSucursalA.token, cuerpo, metodo));
      };
      expect((await llamar(ctx.propertyIdB)).status).toBe(403);
      expect((await llamar(ctx.propertyIdA)).status).not.toBe(403);
    });
  }
});
