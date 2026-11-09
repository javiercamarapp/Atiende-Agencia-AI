// Cerebro v2 + sucursal "solo venta local" (#741, migracion 105; Galerias de PM, decision del dueno 6-nov-2026). Las politicas del 31-oct portadas del suelto
// traian Galerias como sucursal activa con domicilio y promos, y la nombraban en el prompt v2 y en un aviso visible al cliente. Con la bandera cerebro_v2 tampoco
// se ofrece, se asigna ni se menciona: ni en las politicas, ni en el prompt, ni en la precarga, ni al cotizar/crear desde el chat de otra sucursal.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import * as p from "../src/whatsapp/cerebro-v2/politicas-pm.ts";
import { PM_POLICY_RULES_V2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PM = { perfil: "taqueria_pm" as const, agentName: "Lupita", businessName: "Los Taquitos de PM", toneStyle: "formal_directo" as const, deliveryTimeText: "de 40 a 50 minutos" };
const MENCION = /galer/i;
const PHONE = "+5219990001111";

/** PM con Francisco de Montejo (fixture, sucursal del chat) y Galerias ACTIVA con catalogo, coordenadas y tiempo propio: todo lo que la haria ofrecible. */
async function mundo(soloVentaLocal: boolean) {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const galerias = randomUUID();
  f.repo.seedBranch({ propertyId: galerias, organizationId: f.organizationId, name: "Galerías", slug: "galerias", status: "active", phone: "+529999419612", address: "Plaza Galerías, Mérida", lat: 21.0187, lng: -89.6709 });
  f.repo.seedBranchProduct({ propertyId: galerias, productId: f.products.cocaCola, price: 45, isAvailable: true });
  f.repo.seedBranchPolicy(galerias, { aceptaDomicilio: !soloVentaLocal, soloVentaLocal });
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, galerias, { ...PM, deliveryTimeText: "de 20 a 25 minutos" });
  const v2 = { organizationId: f.organizationId, channel: "whatsapp" as const, phone: "9991234567", entryPropertyId: f.propertyId, cerebroV2: true };
  const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
  return { ...f, galerias, v2, items };
}

describe("politicas v2 (datos y textos): Galerias no es sucursal del agente", () => {
  it("sin promos, sin domicilio y fuera del bloque de apertura", () => {
    expect(p.POLITICAS_PM.promos.sucursales).toEqual(["fco-montejo", "pensiones"]);
    expect(p.PROMO_SUCURSALES).not.toContain("galerias");
    expect(p.filaPoliticaPm("galerias")?.promos_en_recoger).toBe(false);
    expect(p.filaPoliticaPm("galerias")?.acepta_domicilio).toBe(false);
    expect(p.sucursalesAperturaPm().map((s) => s.slug)).not.toContain("galerias");
  });

  it("ni el aviso de promos visible al cliente ni el prompt v2 la nombran", () => {
    expect(p.PROMO_SIN_SUCURSAL_NOTICE).not.toMatch(MENCION);
    expect(p.PROMO_SIN_SUCURSAL_NOTICE).toMatch(/Francisco de Montejo y Pensiones/);
    expect(PM_POLICY_RULES_V2).not.toMatch(MENCION);
    expect(PM_POLICY_RULES_V2).toMatch(/Francisco de Montejo/);
  });

  it("«recojo en Plaza Galerías» no se toma como sucursal nombrada y la guardia de promos no la menciona", () => {
    expect(p.sucursalNombrada("lo recojo en Plaza Galerías")).toBeNull();
    expect(p.sucursalesMencionadas("la de plaza galerias")).toEqual([]);
    const r = p.enforcePromoPolicy("Sí, hay 2 x 1 los martes.", [{ role: "user", content: "¿tienen promos? paso a recoger" }]);
    expect(r).not.toMatch(MENCION);
  });
});

describe("herramientas con cerebro v2 desde el chat de otra sucursal", () => {
  it("cotizar_pedido y crear_pedido para recoger en Galerias se rechazan sin crear nada ni dar su tiempo", async () => {
    const m = await mundo(true);
    await expect(invokeAgentTool(m.repo, m.v2, "cotizar_pedido", { branch_slug: "galerias", canal: "recoger", items: m.items })).rejects.toThrow(/no encontrada/);
    await expect(invokeAgentTool(m.repo, m.v2, "crear_pedido", { branch_slug: "galerias", canal: "recoger", items: m.items, customer_name: "Cliente Prueba", payment_method: "efectivo" })).rejects.toThrow(/no encontrada/);
    expect((await m.repo.listOrders(m.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
  });

  it("CONTROL: sin la bandera solo venta local, cotizar en Galerias desde el chat de FdM SI trae su tiempo (aviso de sucursal cruzada)", async () => {
    const m = await mundo(false);
    const r = await invokeAgentTool(m.repo, m.v2, "cotizar_pedido", { branch_slug: "galerias", canal: "recoger", items: m.items });
    expect(JSON.stringify(r.result)).toMatch(/de 20 a 25 minutos/);
  });

  it("buscar_sucursal_cercana con un pin pegado a Galerias no la asigna ni la nombra en el aviso de sucursal cruzada", async () => {
    const m = await mundo(true);
    const r = await invokeAgentTool(m.repo, m.v2, "buscar_sucursal_cercana", { lat: 21.0187, lng: -89.6709 });
    expect(JSON.stringify(r.result)).not.toMatch(MENCION);
  });
});

describe("turno completo con cerebro v2 (prompt y precarga)", () => {
  async function primeraLlamada(soloVentaLocal: boolean, entrada: "fdm" | "galerias", texto: string): Promise<LlmCompletionRequest> {
    const m = await mundo(soloVentaLocal);
    const pedidas: LlmCompletionRequest[] = [];
    const provider = new FakeLlmProvider({ id: "guion", script: (r: LlmCompletionRequest) => (pedidas.push(r), { text: "¿En qué le ayudo?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) });
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
    gateway.registerLadder("default", [provider]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
    // Con la bandera cerebro_v2 el turno usa solo la escalera ZDR.
    gateway.registerZdrLadder("default", [provider]);
    const handler = createLlmWhatsAppTurnHandler(m.repo, gateway, { defaultRole: "default", escalatedRole: "escalated", leerCerebroV2: async () => true });
    await handler.handleInboundMessage({ organizationId: m.organizationId, phone: PHONE, messages: [{ role: "user", content: texto }], customer: { isNew: true as const }, propertyId: entrada === "galerias" ? m.galerias : m.propertyId });
    return pedidas[0]!;
  }
  /** Todo lo que el modelo lee en la primera vuelta menos lo que escribio el cliente. */
  const delServidor = (r: LlmCompletionRequest) => r.system + JSON.stringify(r.messages.filter((x) => x.role !== "user"));

  it("el prompt v2 no la nombra (ni sucursales, ni promociones)", async () => {
    expect(delServidor(await primeraLlamada(true, "fdm", "¿qué promociones tienen para recoger?"))).not.toMatch(MENCION);
  });

  it("un numero ligado a Galerias no la vuelve sucursal de entrada ni de la precarga de productos", async () => {
    const r = await primeraLlamada(true, "galerias", "quiero 2 coca cola");
    expect(delServidor(r)).not.toMatch(MENCION);
    expect(JSON.stringify(r.messages)).not.toMatch(/"branch_slug":"galerias"|branch_slug\\":\\"galerias/);
  });
});
