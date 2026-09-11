import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

describe("POST /v1/restaurantes/:orgSlug/customers/lookup — Server Tool de voz", () => {
  it("401 sin el header x-atiende-tool-secret", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/customers/lookup", jsonRequestInit({ phone: "9991234567" }));
    expect(res.status).toBe(401);
  });

  it("isNew:true para un teléfono nunca visto, con el secreto correcto", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/customers/lookup",
      jsonRequestInit({ phone: "9991234567" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isNew: true });
  });

  it("reconoce a un cliente real que ya pidió, con su tier/frequentItems/agentNotes", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders",
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Reconocido", customer_phone: "9993334444", items: [{ product_id: products.cocaCola, requested_quantity: 1 }], source: "web" }),
    );

    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/customers/lookup",
      jsonRequestInit({ phone: "9993334444" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isNew: boolean; name: string };
    expect(body.isNew).toBe(false);
    expect(body.name).toBe("Reconocido");
  });

  it("400 con un número que no es un teléfono mexicano válido", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/customers/lookup",
      jsonRequestInit({ phone: "123" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
    );
    expect(res.status).toBe(400);
  });
});
