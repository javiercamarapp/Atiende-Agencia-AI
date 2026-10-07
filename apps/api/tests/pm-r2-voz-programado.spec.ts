// QA-PM-R2-voz-01 / reglas-03: la ruta de voz /orders/quote reenviaba SIN programado_para ni hora_recogida, asi que la huella al cotizar y al
// crear difiere ("El pedido no coincide con el que se cotizo") y un pedido programado nunca cerraba por voz.
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

describe("voz: /orders/quote reenvia la hora programada y la hora de recogida", () => {
  it("cotizar con programado_para devuelve la quote con esa hora y crear la deja en `programado`", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const items = [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    const prog = "2026-10-06T20:00:00-06:00";
    const q = await app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", canal: "recoger", items, programado_para: prog }, H));
    expect(q.status).toBe(200);
    expect(((await q.json()) as { quote: { programadoPara?: string } }).quote.programadoPara).toBe("2026-10-07T02:00:00.000Z");
    const c = await app.request(
      `/v1/restaurantes/${ORG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Nora", customer_phone: "9991230000", items, payment_method: "efectivo", canal: "recoger", programado_para: prog }, H),
    );
    expect(c.status).toBe(200);
    expect(((await c.json()) as { order: { status: string } }).order.status).toBe("programado");
  });

  it("cotizar con hora_recogida pasada se rechaza con 400 y la hora local actual", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const items = [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
    const q = await app.request(`/v1/restaurantes/${ORG}/orders/quote`, jsonRequestInit({ branch_slug: "fco-montejo", canal: "recoger", items, hora_recogida: "2026-10-04T20:00:00-06:00" }, H));
    expect(q.status).toBe(400);
    expect(JSON.stringify(await q.json())).toMatch(/ya pasó/);
  });

  it("programado_para y hora_recogida vacios en crear son 'sin programar' (no 400)", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const c = await app.request(
      `/v1/restaurantes/${ORG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Nora", customer_phone: "9991230001", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo", canal: "recoger", programado_para: "", hora_recogida: "" }, H),
    );
    expect(c.status).toBe(200);
    expect(((await c.json()) as { order: { status: string } }).order.status).toBe("pending");
  });
});

describe("token de llamada vencido en /orders (QA-PM-R2-reglas-16)", () => {
  it("responde 401 de token (no el mensaje del checkout web 'Escribe un teléfono de 10 dígitos')", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const r = await app.request(
      `/v1/restaurantes/${ORG}/orders`,
      jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Nora", customer_phone: "9991230002", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }], payment_method: "efectivo", canal: "recoger" }, { "x-atiende-call-token": "token-vencido-o-invalido" }),
    );
    expect(r.status).toBe(401);
    expect(JSON.stringify(await r.json())).toMatch(/Token de llamada inválido o expirado/);
  });
});
