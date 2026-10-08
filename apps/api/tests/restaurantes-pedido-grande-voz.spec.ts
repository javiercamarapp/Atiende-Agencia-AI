// QA R1 (viaje-05, canal de voz por HTTP): el checkout de voz (POST /orders con el secreto de voz) tambien retiene el pedido grande de PM
// en el servidor: NO crea el pedido, deja el aviso `escalada:pedido_grande` y responde 200 con el resultado de la retencion (sin `order`).
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository } from "@atiende/domain-restaurantes";
import { InMemoryComandaOutboxStore, FakeSoftRestaurantAdapter, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
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

  // QA R2 (automatizacion-01, voz): con el autopiloto disponible el pedido grande SI se crea (`por_aprobar`) y la ruta corta antes de la comanda del POS.
  // CR12 (056/326): un domicilio PM por voz sin zonas cargadas se rechaza; el pedido grande no depende de la zona, asi que va para recoger.
  it("CON autopiloto: 100 Coca-Cola en efectivo queda por_aprobar con su solicitud y SIN comanda en el POS ni 'recibido'", async () => {
    const base = await buildTestDeps();
    const { restaurantesRepo, organizationId, products } = base;
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const auto = new InMemoryAutopilotoRepository();
    // El repo del autopiloto en memoria necesita ver el pedido que acaba de crear el repo principal (en la base real es la misma tabla).
    const retener = auto.retenerPedidoGrande.bind(auto);
    auto.retenerPedidoGrande = async (org, orderId, detalle) => {
      const o = await restaurantesRepo.findOrderById(org, orderId);
      if (o) auto.pedidos.set(o.id, { id: o.id, organizationId: o.organizationId, propertyId: o.propertyId, status: "pending", total: o.total, clienteNombre: o.customerName, telefono: o.customerPhone, canal: "recoger", numero: o.orderNumber ?? 1, renglones: [] });
      return retener(org, orderId, detalle);
    };
    const store = new InMemoryComandaOutboxStore({ disponible: true });
    store.ponerModo(organizationId, "activo");
    const app = buildApp({ ...base.deps, autopilotoRepo: () => auto, softRestaurantStore: () => store, softRestaurantPort: new FakeSoftRestaurantAdapter() as unknown as SoftRestaurantPort });
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit(
        { branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230003", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo", canal: "recoger" },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pedido_grande?: boolean; por_aprobar?: boolean; estado?: string; comanda?: unknown };
    expect(body).toMatchObject({ pedido_grande: true, por_aprobar: true, estado: "por_aprobar" });
    expect(body.comanda).toBeUndefined();
    const { orders } = await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 });
    expect(orders).toHaveLength(1);
    expect(store.todas()).toHaveLength(0);
    expect((auto as unknown as { solicitudes: { tipo: string; estado: string }[] }).solicitudes).toMatchObject([{ tipo: "pedido_grande", estado: "pendiente" }]);
  });

  // VZ19 (ronda 5, D31): con el autopiloto el pedido de mas de $4,000 por voz quedaba `por_aprobar` SIN ningun aviso para la sucursal (callbacks=[]); en WhatsApp si escalaba.
  it("VZ19: CON autopiloto, el pedido grande por voz queda por_aprobar Y registra el aviso escalada:pedido_grande para la sucursal (un solo aviso)", async () => {
    const base = await buildTestDeps();
    const { restaurantesRepo, organizationId, products } = base;
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const auto = new InMemoryAutopilotoRepository();
    const retener = auto.retenerPedidoGrande.bind(auto);
    auto.retenerPedidoGrande = async (org, orderId, detalle) => {
      const o = await restaurantesRepo.findOrderById(org, orderId);
      if (o) auto.pedidos.set(o.id, { id: o.id, organizationId: o.organizationId, propertyId: o.propertyId, status: "pending", total: o.total, clienteNombre: o.customerName, telefono: o.customerPhone, canal: "recoger", numero: o.orderNumber ?? 1, renglones: [] });
      return retener(org, orderId, detalle);
    };
    const avisos: Array<{ reason?: string; message?: string; propertyId?: string | null }> = [];
    const original = restaurantesRepo.createCallbackRequest.bind(restaurantesRepo);
    restaurantesRepo.createCallbackRequest = async (input) => {
      avisos.push(input);
      return original(input);
    };
    const app = buildApp({ ...base.deps, autopilotoRepo: () => auto });
    const body = { branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230019", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo", canal: "recoger" };
    const res = await app.request(`/v1/restaurantes/${ORG_SLUG}/orders`, jsonRequestInit(body, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pedido_grande: true, por_aprobar: true });
    const grandes = avisos.filter((c) => c.reason === "escalada:pedido_grande");
    expect(grandes).toHaveLength(1);
    expect(grandes[0]?.message).toMatch(/por_aprobar/);
    expect(grandes[0]?.propertyId).toBeTruthy();
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(1);
  });

  // D31 (revision de #530): el aviso corre en el mismo SAVEPOINT que el pedido. Con un repositorio que SI revierte (aqui: copia y restaura las filas de pedidos), si el aviso no se puede dejar el
  // pedido por aprobar NO queda: nunca hay un pedido grande retenido sin que nadie en la sucursal lo sepa.
  it("D31: si el aviso de pedido grande falla, el SAVEPOINT revierte tambien el pedido por_aprobar", async () => {
    const base = await buildTestDeps();
    const { restaurantesRepo, organizationId, products } = base;
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const auto = new InMemoryAutopilotoRepository();
    const retener = auto.retenerPedidoGrande.bind(auto);
    auto.retenerPedidoGrande = async (org, orderId, detalle) => {
      const o = await restaurantesRepo.findOrderById(org, orderId);
      if (o) auto.pedidos.set(o.id, { id: o.id, organizationId: o.organizationId, propertyId: o.propertyId, status: "pending", total: o.total, clienteNombre: o.customerName, telefono: o.customerPhone, canal: "recoger", numero: o.orderNumber ?? 1, renglones: [] });
      return retener(org, orderId, detalle);
    };
    const repo = restaurantesRepo as unknown as { orders: unknown[]; runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> };
    repo.runWithRowSavepoint = async <T,>(fn: () => Promise<T>): Promise<T> => {
      const copia = [...repo.orders];
      try {
        return await fn();
      } catch (err) {
        repo.orders.splice(0, repo.orders.length, ...copia);
        throw err;
      }
    };
    restaurantesRepo.createCallbackRequest = async () => {
      throw new Error("no se pudo dejar el aviso");
    };
    const app = buildApp({ ...base.deps, autopilotoRepo: () => auto });
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Evento", customer_phone: "9991230021", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 100 }], payment_method: "efectivo", canal: "recoger" }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
  });

  it("VZ19 (negativo): un pedido bajo los umbrales con autopiloto NO registra aviso de pedido grande", async () => {
    const base = await buildTestDeps();
    const { restaurantesRepo, organizationId, products } = base;
    await restaurantesRepo.upsertWhatsAppAgentConfig(organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: "Los Taquitos de PM", toneStyle: null, deliveryTimeText: null, escalationReasonsOff: [] });
    const avisos: Array<{ reason?: string }> = [];
    const original = restaurantesRepo.createCallbackRequest.bind(restaurantesRepo);
    restaurantesRepo.createCallbackRequest = async (input) => {
      avisos.push(input);
      return original(input);
    };
    const app = buildApp({ ...base.deps, autopilotoRepo: () => new InMemoryAutopilotoRepository() });
    const res = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Ana", customer_phone: "9991230020", customer_address: "Calle 20 #300, Mérida", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }], payment_method: "efectivo", canal: "recoger" }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(200);
    expect(avisos.filter((c) => c.reason === "escalada:pedido_grande")).toHaveLength(0);
  });
});
