// Decision de producto (7-oct): los pedidos entran por WhatsApp o por llamada; la tienda en linea (/pedir, storefront) NO existe.
// Estas rutas ya no estan montadas: responden 404 y no crean ni leen nada.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";

describe("la tienda en linea ya no existe", () => {
  it.each([
    ["GET", `/v1/restaurantes/${ORG}/storefront`],
    ["GET", `/v1/restaurantes/${ORG}/storefront/directorio`],
    ["GET", `/v1/restaurantes/${ORG}/storefront/fco-montejo/menu`],
    ["GET", `/v1/restaurantes/${ORG}/storefront/track/abc.def`],
    ["GET", `/v1/restaurantes/${ORG}/storefront/sitemap.xml`],
    ["GET", `/pedir/${ORG}`],
    ["GET", `/pedir/${ORG}/fco-montejo`],
  ])("%s %s -> 404", async (method, ruta) => {
    const { deps } = await buildTestDeps();
    const res = await buildApp(deps).request(ruta, { method });
    expect(res.status).toBe(404);
  });

  it.each(["quote", "confirm", "orders"])("POST .../storefront/fco-montejo/%s -> 404 y no crea ningun pedido", async (accion) => {
    const { deps, products, restaurantesRepo, organizationId } = await buildTestDeps();
    const cuerpo = { session_id: "sesion-0123456789abcdef", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], canal: "recoger", payment_method: "efectivo", customer_name: "X", customer_phone: "9991234567", acepta_aviso_privacidad: true };
    const res = await buildApp(deps).request(`/v1/restaurantes/${ORG}/storefront/fco-montejo/${accion}`, jsonRequestInit(cuerpo, { origin: "http://localhost:5173" }));
    expect(res.status).toBe(404);
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 100 })).orders).toHaveLength(0);
  });

  it("la configuracion «Sitio publico» del panel ya no existe: la ruta no esta montada (404, no 401)", async () => {
    const t = await buildTestDeps();
    const app = buildApp(t.deps);
    for (const method of ["GET", "PUT"]) {
      const res = await app.request(`/v1/restaurantes/${t.propertyId}/admin/config/sitio-publico`, { method });
      expect(res.status).toBe(404);
    }
  });
});
