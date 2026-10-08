// Modelo PM (migracion 023): las reglas por sucursal llegan por HTTP -- voz (cotizar) y
// voz (crear pedido) devuelven 400 con el mensaje claro de la regla, y aceptan
// canal / colonia_entrega / propina. HTTP real sobre buildTestDeps (in-memory).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const TOOL = { "x-atiende-tool-secret": "test-voice-tool-secret" };

describe("reglas de pedido por HTTP", () => {
  it("cotizar (voz): bajo el minimo a domicilio -> 400 con el monto y el faltante; recoger -> 200 con la politica", async () => {
    const { deps, restaurantesRepo, propertyId, products } = await buildTestDeps();
    restaurantesRepo.seedBranchPolicy(propertyId, { pedidoMinimoDomicilio: 200, propinaPolitica: "solo_tarjeta" });
    const app = buildApp(deps);
    const items = [{ product_id: products.cocaCola, requested_quantity: 2 }];

    const rechazado = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders/quote", jsonRequestInit({ branch_slug: "fco-montejo", items }, TOOL));
    expect(rechazado.status).toBe(400);
    expect(JSON.stringify(await rechazado.json())).toContain("El pedido mínimo a domicilio");

    const recoger = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders/quote", jsonRequestInit({ branch_slug: "fco-montejo", items, canal: "recoger", payment_method: "tarjeta" }, TOOL));
    expect(recoger.status).toBe(200);
    const body = (await recoger.json()) as { quote: { total: number; canal: string; propinaPolitica: string; preguntarPropina: boolean } };
    expect(body.quote).toMatchObject({ total: 90, canal: "recoger", propinaPolitica: "solo_tarjeta", preguntarPropina: true });
  });

  it("crear pedido (voz): pedido bajo el minimo -> 400 y no se crea; con minimo cumplido -> 200", async () => {
    const { deps, restaurantesRepo, propertyId, products } = await buildTestDeps();
    restaurantesRepo.seedBranchPolicy(propertyId, { pedidoMinimoDomicilio: 100 });
    const app = buildApp(deps);
    const base = { branch_slug: "fco-montejo", customer_name: "Cliente Web", customer_phone: "9991234567", customer_address: "Calle 1 #200, Centro", payment_method: "efectivo", source: "voice" };

    const bajo = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit({ ...base, items: [{ product_id: products.cocaCola, requested_quantity: 1 }] }, TOOL));
    expect(bajo.status).toBe(400);
    expect(JSON.stringify(await bajo.json())).toContain("faltan $55");

    const ok = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit({ ...base, items: [{ product_id: products.cocaCola, requested_quantity: 3 }] }, TOOL));
    expect(ok.status).toBe(200);
  });

  it("crear pedido por voz: colonia fuera de zona -> 400; dentro de zona -> 200; propina con efectivo -> 400", async () => {
    const { deps, restaurantesRepo, organizationId, propertyId, products } = await buildTestDeps();
    const zonaCubierta = "00000000-0000-4000-8000-00000000aaa1";
    restaurantesRepo.seedKnownZone({ id: zonaCubierta, organizationId, name: "Altabrisa", lat: 21.06, lng: -89.62 });
    restaurantesRepo.seedKnownZone({ id: "00000000-0000-4000-8000-00000000aaa2", organizationId, name: "Pensiones", lat: 20.96, lng: -89.66 });
    restaurantesRepo.seedBranchDeliveryZones(propertyId, [zonaCubierta]);
    restaurantesRepo.seedBranchPolicy(propertyId, { propinaPolitica: "solo_tarjeta" });
    const app = buildApp(deps);
    const base = {
      branch_slug: "fco-montejo",
      customer_name: "Marcela Pech",
      customer_phone: "9991234567",
      customer_address: "Calle 7 #210",
      items: [{ product_id: products.cocaCola, requested_quantity: 2 }],
      payment_method: "efectivo",
    };
    const crear = (extra: Record<string, unknown>) => app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit({ ...base, ...extra }, TOOL));

    const fuera = await crear({ colonia_entrega: "Pensiones" });
    expect(fuera.status).toBe(400);
    expect(JSON.stringify(await fuera.json())).toContain("fuera de la zona de reparto");

    const propinaEfectivo = await crear({ colonia_entrega: "Altabrisa", propina: 20 });
    expect(propinaEfectivo.status).toBe(400);

    const ok = await crear({ colonia_entrega: "Altabrisa", payment_method: "tarjeta", propina: 20 });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { order: { notes: string; total: number } };
    expect(body.order.total).toBe(90);
    expect(body.order.notes).toContain("Propina: $20.00");
  });

  it("canal fuera del catalogo -> 400", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", canal: "drive-thru", items: [{ product_id: products.cocaCola, requested_quantity: 1 }] }, TOOL),
    );
    expect(res.status).toBe(400);
  });
});
