// Cierra el gap real de auditoría: "el agente de voz no puede completar un
// pedido por teléfono porque faltan buscar_cliente y crear_pedido". La
// investigación mostró que las 3 tools documentadas en
// docs/agente-voz/system-prompt.md §3 del repo original (3.1 buscar_cliente,
// 3.2 cotizar_pedido, 3.3 crear_pedido) YA están implementadas como Server
// Tools HTTP reales protegidas con `x-atiende-tool-secret` — buscar_cliente y
// crear_pedido viven en public.ts (Fase 1, anteriores a voice-tools.ts),
// cotizar_pedido vive en voice-tools.ts (Fase 2 §1.3) — pero NINGÚN test
// existente ejercita las 3 juntas como un flujo real de llamada telefónica de
// punta a punta. `voice-tools.spec.ts` y `public-*.spec.ts` prueban cada
// endpoint aislado; este archivo prueba el flujo completo que el brief
// original destaca como el valor central del agente de voz: "arma el
// pedido... antes de colgar", incluyendo el saludo que reconoce a un cliente
// recurrente por su historial real.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const ORG_SLUG = "los-taquitos-de-pm";

describe("Flujo cerrado del agente de voz por teléfono (buscar_cliente -> cotizar_pedido -> crear_pedido)", () => {
  it("un cliente nuevo llama, pide y cuelga con el pedido real cerrado en cocina — las 3 tools, una sola llamada, con el mismo secreto", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const phone = "9991230000";

    // 3.1 buscar_cliente — primera vez que llama este número, memoria vacía.
    const lookup1 = await app.request(`/v1/restaurantes/${ORG_SLUG}/customers/lookup`, jsonRequestInit({ phone }, TOOL_SECRET_HEADERS));
    expect(lookup1.status).toBe(200);
    expect(await lookup1.json()).toEqual({ isNew: true });

    // 3.2 cotizar_pedido — antes de decir el total, el agente cotiza server-side.
    const quote = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders/quote`,
      jsonRequestInit(
        { branch_slug: "fco-montejo", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(quote.status).toBe(200);
    expect(((await quote.json()) as { quote: { total: number } }).quote.total).toBe(90);

    // 3.3 crear_pedido — el paso que el audit marcaba como imposible por voz:
    // el pedido real se cierra en cocina ANTES de colgar, con el secreto de
    // voz forzando source:"voice" sin que el LLM tenga que declararlo.
    const create = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit(
        {
          branch_slug: "fco-montejo",
          customer_name: "Cliente Telefónico",
          customer_phone: phone,
          customer_address: "Calle 20 #300, Mérida",
          items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }],
          payment_method: "efectivo",
        },
        TOOL_SECRET_HEADERS,
      ),
    );
    expect(create.status).toBe(200);
    const createdOrder = ((await create.json()) as { order: { source: string; total: number; status: string } }).order;
    expect(createdOrder.source).toBe("voice"); // forzado por el secreto, nunca por el body.
    expect(createdOrder.total).toBe(90);
    expect(createdOrder.status).toBe("pending");

    // El cliente vuelve a llamar después: el agente lo saluda como recurrente,
    // con su historial real ("lo de siempre") — la memoria que el brief pide.
    const lookup2 = await app.request(`/v1/restaurantes/${ORG_SLUG}/customers/lookup`, jsonRequestInit({ phone }, TOOL_SECRET_HEADERS));
    expect(lookup2.status).toBe(200);
    const returningCustomer = (await lookup2.json()) as { isNew: boolean; name: string; orderCount: number; frequentItems: Array<{ name: string }> };
    expect(returningCustomer.isNew).toBe(false);
    expect(returningCustomer.name).toBe("Cliente Telefónico");
    expect(returningCustomer.orderCount).toBe(1);
    expect(returningCustomer.frequentItems.map((i) => i.name)).toContain("Coca-Cola");
  });

  it("sin el secreto de voz, ninguna de las 3 tools deja pasar la llamada (contrato de auth uniforme)", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);

    const lookup = await app.request(`/v1/restaurantes/${ORG_SLUG}/customers/lookup`, jsonRequestInit({ phone: "9991230000" }));
    expect(lookup.status).toBe(401);

    const quote = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders/quote`,
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.cocaCola, requested_quantity: 1 }] }),
    );
    expect(quote.status).toBe(401);

    // crear_pedido sin secreto y sin declarar source:"voice" cae como pedido
    // web normal (contrato ya probado en public-orders.spec.ts); declarar
    // source:"voice" sin el secreto es lo que debe rechazarse con 401.
    const create = await app.request(
      `/v1/restaurantes/${ORG_SLUG}/orders`,
      jsonRequestInit({
        branch_slug: "fco-montejo",
        customer_name: "X",
        customer_phone: "9991230000",
        customer_address: "Calle 1",
        items: [{ product_id: products.cocaCola, requested_quantity: 1 }],
        source: "voice",
      }),
    );
    expect(create.status).toBe(401);
  });
});
