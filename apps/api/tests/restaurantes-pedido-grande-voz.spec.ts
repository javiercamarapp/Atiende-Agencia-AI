// QA R1 (viaje-05, canal de voz por HTTP): el checkout de voz (POST /orders con el secreto de voz) tambien retiene el pedido grande de PM
// en el servidor: NO crea el pedido, deja el aviso `escalada:pedido_grande` y responde 200 con el resultado de la retencion (sin `order`).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const ORG_SLUG = "los-taquitos-de-pm";

describe("POST /orders de voz: pedido grande de PM", () => {
  // CR12: un domicilio de PM por voz sin zonas de reparto cargadas exige pin o persona antes de cualquier otra regla; este caso prueba el
  // pedido grande, que no depende de la zona, y por eso es para recoger.
  it("100 Coca-Cola ($4,500) en efectivo de un numero sin historial: no se crea, queda el aviso para la sucursal", async () => {
    const { deps, restaurantesRepo, organizationId, products } = await buildTestDeps();
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const avisos: Array<{ reason?: string }> = [];
    const original = restaurantesRepo.createCallbackRequest.bind(restaurantesRepo);
    restaurantesRepo.createCallbackRequest = async (input) => {
      avisos.push(input);
      return original(input);
    };
    const app = buildApp(deps);
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230001", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo", canal: "recoger" },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order?: unknown; pedido_grande?: boolean; estado?: string };
    expect(body.order).toBeUndefined();
    expect(body.pedido_grande).toBe(true);
    expect(body.estado).toBe("por_confirmar_por_la_sucursal");
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
    expect(avisos.some((c) => c.reason === "escalada:pedido_grande")).toBe(true);
  });

  it("CR12: domicilio de PM por voz sin zonas de reparto cargadas se rechaza pidiendo pin o persona (400), no se crea", async () => {
    const { deps, restaurantesRepo, organizationId, products } = await buildTestDeps();
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const app = buildApp(deps);
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230001", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo" }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/pin|ubicaci/i);
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
  });

  it("sin perfil de PM (organizacion generica) el mismo pedido se crea como siempre", async () => {
    const { deps, restaurantesRepo, organizationId, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230002", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo" },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order: { total: number } }).order.total).toBe(4500);
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(1);
  });
});
