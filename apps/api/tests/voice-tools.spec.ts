// Fase 2 §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs.
// Mismo patrón de test que public-orders.spec.ts/public-customer-lookup.spec.ts:
// HTTP real vía `app.request`, sobre `buildTestDeps()` (in-memory), sin mocks
// de la lógica de negocio.
import { describe, expect, it } from "vitest";
import type { InMemoryRestaurantesRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const TOOL_SECRET_HEADERS = { "x-atiende-tool-secret": "test-voice-tool-secret" };

describe("POST /v1/restaurantes/:orgSlug/branches/nearest — buscar_sucursal_cercana", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/branches/nearest", jsonRequestInit({ colonia: "Cualquiera" }));
    expect(res.status).toBe(401);
  });

  it("404 con un restaurante que no existe, incluso con el secreto correcto", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/no-existe/branches/nearest", jsonRequestInit({ colonia: "Cualquiera" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(404);
  });

  it("400 si falta colonia", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/branches/nearest", jsonRequestInit({}, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
  });

  it("una colonia reconocida devuelve la sucursal real más cercana calculada por distancia (nunca adivinada)", async () => {
    const { deps } = await buildTestDeps();
    (deps.restaurantesRepo as InMemoryRestaurantesRepository).seedKnownZone({
      organizationId: (await deps.restaurantesRepo.findOrganizationBySlug("los-taquitos-de-pm"))!.id,
      name: "Francisco de Montejo",
      lat: 21.0186,
      lng: -89.6708,
    });
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/branches/nearest", jsonRequestInit({ colonia: "Montejo" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { encontrada: boolean; branch_slug?: string; distancia_km?: number };
    expect(body.encontrada).toBe(true);
    expect(body.branch_slug).toBe("fco-montejo");
    expect(body.distancia_km).toBe(0);
  });

  it("CONTRATO DE SILENCIO: una colonia no reconocida nunca inventa una sucursal — encontrada:false con el mensaje real", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/branches/nearest", jsonRequestInit({ colonia: "Una colonia que no existe en ningún lado" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { encontrada: boolean; mensaje?: string };
    expect(body.encontrada).toBe(false);
    expect(body.mensaje).toMatch(/No reconozco esa colonia/);
  });
});

describe("POST /v1/restaurantes/:orgSlug/products/search — buscar_producto", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query: "taco", branch_slug: "fco-montejo" }));
    expect(res.status).toBe(401);
  });

  it("400 si falta branch_slug — nunca cae en silencio a una sucursal default (bug real corregido 3-sep-2026)", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query: "taco" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
  });

  it("400 si branch_slug no existe — nunca busca en otra sucursal en silencio", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query: "taco", branch_slug: "sucursal-inventada" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/no encontrada/);
  });

  it("busca productos reales de la sucursal, con precio/pack_size/requires_adult_confirmation reales — nunca inventados", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query: "bistec", branch_slug: "fco-montejo" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productos: Array<{ name: string; price: number; pack_size: number | null; requires_adult_confirmation: boolean }> };
    expect(body.productos).toHaveLength(1);
    expect(body.productos[0]).toMatchObject({ name: "Tacos de Bistec de Res (orden de 3)", price: 164, pack_size: 3, requires_adult_confirmation: false });
  });

  it("una lista vacía es una respuesta 200 real — 'no existe en el menú', no un error", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/products/search", jsonRequestInit({ query: "pizza hawaiana", branch_slug: "fco-montejo" }, TOOL_SECRET_HEADERS));
    expect(res.status).toBe(200);
    expect((await res.json()) as { productos: unknown[] }).toEqual({ productos: [] });
  });
});

describe("POST /v1/restaurantes/:orgSlug/orders/quote — cotizar_pedido", () => {
  it("401 sin el secreto de la herramienta de voz", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.cocaCola, requested_quantity: 1 }] }),
    );
    expect(res.status).toBe(401);
  });

  it("cotiza con precio real server-side — el LLM debe repetir esto, nunca calcularlo", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quote: { total: number; containsAlcohol: boolean } };
    expect(body.quote.total).toBe(90);
    expect(body.quote.containsAlcohol).toBe(false);
  });

  it("400 con el mensaje EXACTO de presentación fija cuando la cantidad no es múltiplo del pack_size — el agente debe leerlo tal cual", async () => {
    const { deps, products } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 4, tortilla: "maiz" }] }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/solo se vende en órdenes de 3/);
  });

  it("400 con un producto fuera del catálogo real — guardia anti-alucinación de precio", async () => {
    const { deps } = await buildTestDeps();
    const app = buildApp(deps);
    const res = await app.request(
      "/v1/restaurantes/los-taquitos-de-pm/orders/quote",
      jsonRequestInit({ branch_slug: "fco-montejo", items: [{ product_id: "00000000-0000-4000-8000-000000000000", requested_quantity: 1 }] }, TOOL_SECRET_HEADERS),
    );
    expect(res.status).toBe(400);
  });
});
