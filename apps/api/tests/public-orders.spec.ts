import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

describe("POST /v1/restaurantes/:orgSlug/orders — checkout web público", () => {
  it("crea un pedido real, re-cotizado server-side, sin necesitar ningún secreto para web", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "Cliente Web",
          customer_phone: "9991234567",
          items: [{ product_id: products.cocaCola, requested_quantity: 2 }],
          source: "web",
        },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { total: number; status: string } };
    expect(body.order.status).toBe("pending");
    expect(body.order.total).toBe(90); // 2 Coca-Cola a $45
  });

  it("403 con un Origin no permitido", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "X", customer_phone: "9991234567", items: [], source: "web" }, { origin: "https://sitio-no-permitido.mx" }),
    );
    expect(res.status).toBe(403);
  });

  it("404 con un restaurante (orgSlug) que no existe", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/no-existe/orders",
      jsonRequestInit({ branch_slug: "x", customer_name: "X", customer_phone: "9991234567", items: [], source: "web" }),
    );
    expect(res.status).toBe(404);
  });

  it("401 si source='voice' sin el header x-atiende-tool-secret", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "X", customer_phone: "9991234567", customer_address: "Calle 1", items: [], source: "voice" }),
    );
    expect(res.status).toBe(401);
  });

  it("200 con source='voice' y el header x-atiende-tool-secret correcto", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "Cliente de Voz",
          customer_phone: "9991234567",
          customer_address: "Calle 1 #200",
          items: [{ product_id: products.cocaCola, requested_quantity: 1 }],
          source: "voice",
          payment_method: "efectivo",
        },
        { "x-atiende-tool-secret": "test-voice-tool-secret" },
      ),
    );
    expect(res.status).toBe(200);
  });

  it("400 con un producto que no existe en el catálogo (guardia anti-alucinación de precio, de punta a punta vía HTTP)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({
        branch_slug: "fco-montejo",
        customer_name: "X",
        customer_phone: "9991234567",
        items: [{ product_id: "00000000-0000-4000-8000-000000000000", requested_quantity: 1 }],
        source: "web",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/no disponible/i);
  });

  it("un idempotency_key repetido devuelve el MISMO pedido vía HTTP (idempotencia real de punta a punta)", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const payload = {
      branch_slug: "fco-montejo",
      customer_name: "Cliente Idempotente",
      customer_phone: "9991110000",
      items: [{ product_id: products.cocaCola, requested_quantity: 1 }],
      source: "web",
      idempotency_key: "checkout-abc-123",
    };
    const first = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit(payload));
    const second = await app.request("/v1/restaurantes/los-taquitos-de-pm/orders", jsonRequestInit(payload));
    const firstBody = (await first.json()) as { order: { id: string } };
    const secondBody = (await second.json()) as { order: { id: string } };
    expect(secondBody.order.id).toBe(firstBody.order.id);
  });

  // Fase 11 — promociones/marketing aplicadas de punta a punta por HTTP (ver
  // domain-restaurantes/src/promotions.ts).
  it("promo_code real: descuenta del total del checkout público", async () => {
    const { deps, restaurantesRepo, organizationId, products } = await buildTestDeps();
    await restaurantesRepo.createPromotion(organizationId, { code: "WEB10", name: "10% checkout web", type: "percentage", value: 10 });
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "Cliente con Cupón",
          customer_phone: "9991230099",
          items: [{ product_id: products.cocaCola, requested_quantity: 2 }],
          source: "web",
          promo_code: "web10",
        },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { total: number; notes: string | null } };
    expect(body.order.total).toBe(81); // 90 - 10%
    expect(body.order.notes ?? "").toMatch(/Promoción aplicada: WEB10 \(-\$9\.00\)/);
  });

  it("promo_code inexistente -> 400, el pedido nunca se crea", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "X",
          customer_phone: "9991230098",
          items: [{ product_id: products.cocaCola, requested_quantity: 1 }],
          source: "web",
          promo_code: "NO-EXISTE",
        },
        { origin: "http://localhost:5173" },
      ),
    );
    expect(res.status).toBe(400);
  });
});
