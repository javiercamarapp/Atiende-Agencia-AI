import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const TOOL = { "x-atiende-tool-secret": "test-voice-tool-secret" };

describe("POST /v1/restaurantes/:orgSlug/orders — solo canal de voz (el checkout web público ya no existe)", () => {
  it("sin credenciales de voz responde 401 y NO crea ningún pedido (antes era el checkout web)", async () => {
    const { deps, products, restaurantesRepo, organizationId } = await buildTestDeps();
    const app = buildApp(deps);
    const antes = (await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 100 })).orders.length;
    for (const source of ["web", undefined]) {
      const res = await app.request(
        "/v1/restaurantes/los-taquitos-de-pm/orders",
        jsonRequestInit(
          { branch_slug: "fco-montejo", customer_name: "Cliente Web", customer_phone: "9991234567", items: [{ product_id: products.cocaCola, requested_quantity: 2 }], source, canal: "recoger", payment_method: "efectivo" },
          { origin: "http://localhost:5173" },
        ),
      );
      expect(res.status).toBe(401);
    }
    expect((await restaurantesRepo.listOrders(organizationId, { propertyIds: null, limit: 100 })).orders.length).toBe(antes);
  });

  it("una credencial de voz inválida con source='web' tampoco crea un pedido web (401)", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "X", customer_phone: "9991234567", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], source: "web", canal: "recoger", payment_method: "efectivo" }, { "x-atiende-tool-secret": "secreto-incorrecto" }),
    );
    expect(res.status).toBe(401);
  });

  it("404 con un restaurante (orgSlug) que no existe", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/no-existe/orders",
      jsonRequestInit({ branch_slug: "x", customer_name: "X", customer_phone: "9991234567", items: [], source: "voice" }, TOOL),
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
        TOOL,
      ),
    );
    expect(res.status).toBe(200);
  });

  it("400 con un producto que no existe en el catálogo (guardia anti-alucinación de precio, vía HTTP de voz)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "X",
          customer_phone: "9991234567",
          customer_address: "Calle 1 #200",
          items: [{ product_id: "00000000-0000-4000-8000-000000000000", requested_quantity: 1 }],
          source: "voice",
          payment_method: "efectivo",
        },
        TOOL,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/no disponible/i);
  });
});
