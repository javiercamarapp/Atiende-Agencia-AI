// QA-PM-R6: la ruta de voz /orders/quote descartaba `minutos_para_recoger` y `otro_pedido`, que el prompt de voz manda en cotizar_pedido. Con reloj fijo (martes 13:00 Merida).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const H = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const ORG = "los-taquitos-de-pm";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T13:00:00-06:00"));
});
afterEach(() => vi.useRealTimers());

describe("voz: /orders/quote reenvia el plazo en minutos (si lo descartara, el plazo invalido no se rechazaria)", () => {
  it("un plazo invalido (negativo, fraccion, texto) se rechaza con 400 en lugar de ignorarse; 0, vacio y null son 'sin dato'", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const items = [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
    for (const malo of [-5, 2.5, "mucho", 99999]) {
      const r = await app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", canal: "recoger", items, minutos_para_recoger: malo }, H));
      expect(r.status, JSON.stringify(malo)).toBe(400);
    }
    for (const vacio of [0, "", null]) {
      const r = await app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", canal: "recoger", items, minutos_para_recoger: vacio }, H));
      expect(r.status, JSON.stringify(vacio)).toBe(200);
    }
  });
});
