// Modelo PM: el numero de WhatsApp identifica la sucursal. Cubre la resolucion en el
// repositorio (numero de sucursal > numero por defecto de la organizacion, unicidad cruzada),
// el contexto que recibe el agente (prompt solo cuando hay sucursal de entrada) y el numero
// SALIENTE por sucursal para las notificaciones del pedido.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { WhatsappNumberInUseError } from "../src/errors.ts";
import { resolveWhatsAppChannel } from "../src/whatsapp/channel-config.ts";
import { branchChannelRules, createLlmWhatsAppTurnHandler, TOOLS } from "../src/whatsapp/llm-turn-handler.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../src/order-notifications.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function dosSucursales() {
  const f = buildRestaurantFixture();
  const propertyB = randomUUID();
  f.repo.seedBranch({ propertyId: propertyB, organizationId: f.organizationId, name: "Victory Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null });
  return { ...f, propertyB };
}

describe("resolveWhatsAppChannel", () => {
  it("numero de sucursal -> organizacion + sucursal; numero por defecto -> solo organizacion; desconocido -> null", async () => {
    const f = dosSucursales();
    f.repo.seedWhatsAppChannel(f.organizationId, "pn-org");
    f.repo.seedWhatsAppBranchChannel(f.organizationId, f.propertyB, "pn-b");
    expect(await resolveWhatsAppChannel(f.repo, "pn-b")).toEqual({ organizationId: f.organizationId, propertyId: f.propertyB });
    expect(await resolveWhatsAppChannel(f.repo, "pn-org")).toEqual({ organizationId: f.organizationId, propertyId: null });
    expect(await resolveWhatsAppChannel(f.repo, "pn-x")).toBeNull();
  });

  it("conectar/rotar/desconectar el numero de una sucursal; una sucursal tiene un solo numero", async () => {
    const f = dosSucursales();
    await f.repo.upsertWhatsappBranchChannel(f.organizationId, f.propertyB, "pn-1");
    await f.repo.upsertWhatsappBranchChannel(f.organizationId, f.propertyB, "pn-2"); // rota
    expect(await f.repo.listWhatsappBranchChannels(f.organizationId)).toEqual([{ propertyId: f.propertyB, phoneNumberId: "pn-2" }]);
    expect(await resolveWhatsAppChannel(f.repo, "pn-1")).toBeNull();
    expect(await f.repo.deleteWhatsappBranchChannel(f.organizationId, f.propertyB)).toBe(true);
    expect(await f.repo.deleteWhatsappBranchChannel(f.organizationId, f.propertyB)).toBe(false);
  });

  it("aislamiento: no se conecta un numero a una sucursal de otra organizacion ni se comparte entre organizaciones", async () => {
    const f = dosSucursales();
    const otraOrg = randomUUID();
    const otraSucursal = randomUUID();
    f.repo.seedOrganization({ id: otraOrg, slug: "otra", name: "Otra" });
    f.repo.seedBranch({ propertyId: otraSucursal, organizationId: otraOrg, name: "X", slug: "x", status: "active", phone: null, address: null, lat: null, lng: null });
    await expect(f.repo.upsertWhatsappBranchChannel(f.organizationId, otraSucursal, "pn-z")).rejects.toThrow();
    await f.repo.upsertWhatsappBranchChannel(f.organizationId, f.propertyB, "pn-comun");
    await expect(f.repo.upsertWhatsappBranchChannel(otraOrg, otraSucursal, "pn-comun")).rejects.toBeInstanceOf(WhatsappNumberInUseError);
    f.repo.seedWhatsAppChannel(f.organizationId, "pn-default-a");
    await expect(f.repo.upsertWhatsappBranchChannel(otraOrg, otraSucursal, "pn-default-a")).rejects.toBeInstanceOf(WhatsappNumberInUseError);
    await expect(f.repo.upsertWhatsappChannelConfig(otraOrg, "pn-comun")).rejects.toBeInstanceOf(WhatsappNumberInUseError);
  });
});

describe("numero saliente por sucursal (notificaciones del pedido)", () => {
  it("el aviso al cliente sale por el numero de la sucursal del pedido, con respaldo al numero por defecto", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedWhatsAppChannel(f.organizationId, "pn-org");
    const base = {
      organizationId: f.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Ana",
      customerPhone: "9995550000",
      customerAddress: "Calle 1",
      items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }],
      source: "whatsapp" as const,
      paymentMethod: "efectivo" as const,
    };
    const sinNumeroDeSucursal = await createOrder(f.repo, base);
    expect(await f.repo.resolveActiveWhatsAppPhoneNumberId(f.organizationId, sinNumeroDeSucursal.propertyId)).toBe("pn-org");

    f.repo.seedWhatsAppBranchChannel(f.organizationId, f.propertyId, "pn-suc");
    const order = await createOrder(f.repo, { ...base, customerPhone: "9995550001" });
    const result = await notifyCustomerOnOrderStatusChangeCore(f.repo, { ...order, status: "preparando" });
    expect(result.enqueued).toBe(true);
    const batch = await f.repo.claimMessagingOutboxBatch(10, 60);
    expect(batch.some((row) => (row.payload as { phone_number_id?: string }).phone_number_id === "pn-suc")).toBe(true);
  });
});

function scriptedHandler(repo: InMemoryRestaurantesRepository, script: (request: LlmCompletionRequest) => LlmCompletionResult) {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "scripted", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "unused" })]);
  return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}

describe("agente de WhatsApp con sucursal de entrada", () => {
  const mensajes = [{ role: "user" as const, content: "Hola" }];

  it("con sucursal de entrada: el prompt fija la sucursal y explica canal/propina; la sucursal queda en la conversacion", async () => {
    const f = dosSucursales();
    const prompts: string[] = [];
    const handler = scriptedHandler(f.repo, (req) => {
      prompts.push(req.system ?? "");
      return { text: "Hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    const turn = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990000000", messages: mensajes, customer: { isNew: true }, propertyId: f.propertyB });
    expect(prompts[0]).toContain('SUCURSAL DE ESTE CHAT: el cliente escribió al WhatsApp de la sucursal "Victory Altabrisa" (branch_slug: "altabrisa")');
    expect(prompts[0]).toContain("PROPINA:");
    expect(turn.propertyId).toBe(f.propertyB);
  });

  it("sin sucursal de entrada el prompt NO cambia (otros restaurantes no se ven afectados)", async () => {
    const f = dosSucursales();
    const prompts: string[] = [];
    const handler = scriptedHandler(f.repo, (req) => {
      prompts.push(req.system ?? "");
      return { text: "Hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    const turn = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990000000", messages: mensajes, customer: { isNew: true } });
    expect(prompts[0]).not.toContain("SUCURSAL DE ESTE CHAT");
    expect(turn.propertyId).toBeNull();
  });

  it("una sucursal de entrada inactiva o de otra organizacion se ignora", async () => {
    const f = dosSucursales();
    f.repo.seedBranch({ propertyId: f.propertyB, organizationId: f.organizationId, name: "Victory Altabrisa", slug: "altabrisa", status: "inactive", phone: null, address: null, lat: null, lng: null });
    const prompts: string[] = [];
    const handler = scriptedHandler(f.repo, (req) => {
      prompts.push(req.system ?? "");
      return { text: "Hola", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990000000", messages: mensajes, customer: { isNew: true }, propertyId: f.propertyB });
    await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219990000000", messages: mensajes, customer: { isNew: true }, propertyId: randomUUID() });
    expect(prompts.every((p) => !p.includes("SUCURSAL DE ESTE CHAT"))).toBe(true);
  });

  it("las tools exponen canal, colonia_entrega, payment_method (cotizar) y propina (crear); la direccion ya no es obligatoria para recoger", () => {
    const cotizar = TOOLS.find((t) => t.name === "cotizar_pedido")!.parameters as { properties: Record<string, unknown> };
    const crear = TOOLS.find((t) => t.name === "crear_pedido")!.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(cotizar.properties)).toEqual(expect.arrayContaining(["canal", "colonia_entrega", "payment_method"]));
    expect(Object.keys(crear.properties)).toEqual(expect.arrayContaining(["canal", "colonia_entrega", "propina"]));
    expect(crear.required).not.toContain("customer_address");
  });

  it("flujo completo: recoger sin direccion, con tarjeta y propina; cotiza en un mensaje, el cliente confirma en el siguiente; la cotizacion devuelve la politica al modelo", async () => {
    const f = dosSucursales();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoRecoger: 40, propinaPolitica: "solo_tarjeta" });
    const toolResults: unknown[] = [];
    let paso = 0;
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    const llamada = (id: string, name: string, args: object) => ({ text: "", toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
    const handler = scriptedHandler(f.repo, (req) => {
      const tool = [...req.messages].reverse().find((m) => m.role === "tool");
      if (tool && tool.role === "tool") toolResults.push(JSON.parse(tool.content));
      paso += 1;
      if (paso === 1) return llamada("c1", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", payment_method: "tarjeta", items });
      if (paso === 2) return { text: "Son 2 Coca-Cola, $90. ¿Confirmas?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      // Segundo mensaje del cliente ("si, con tarjeta"): confirma y crea.
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      if (paso === 4) return llamada("c3", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Luis Canul", payment_method: "tarjeta", propina: 15, items });
      return { text: "Listo, ya está en cocina.", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    const phone = "+5219997654321";
    const turno1 = await handler.handleInboundMessage({ organizationId: f.organizationId, phone, messages: mensajes, customer: { isNew: true }, propertyId: f.propertyId });
    expect(turno1.orderId).toBeNull();
    const mensajes2 = [...mensajes, { role: "assistant" as const, content: turno1.reply }, { role: "user" as const, content: "si, con tarjeta" }];
    const turn = await handler.handleInboundMessage({ organizationId: f.organizationId, phone, messages: mensajes2, customer: { isNew: true }, propertyId: f.propertyId });
    expect(turn.orderId).not.toBeNull();
    const quote = (toolResults[0] as { quote: { canal: string; pedido_minimo: number; propina_politica: string; preguntar_propina: boolean } }).quote;
    expect(quote).toMatchObject({ canal: "recoger", pedido_minimo: 40, propina_politica: "solo_tarjeta", preguntar_propina: true });
    const order = await f.repo.findOrderById(f.organizationId, turn.orderId!);
    expect(order?.notes).toContain("Canal: recoger en sucursal.");
    expect(order?.notes).toContain("Propina: $15.00");
    expect(order?.customerAddress).toBeNull();
  });

  it("un rechazo por regla dura (minimo a domicilio) llega al modelo como error de la herramienta y NO crea pedido", async () => {
    const f = dosSucursales();
    f.repo.seedBranchPolicy(f.propertyId, { pedidoMinimoDomicilio: 200 });
    const toolResults: unknown[] = [];
    let paso = 0;
    const handler = scriptedHandler(f.repo, (req) => {
      const tool = [...req.messages].reverse().find((m) => m.role === "tool");
      if (tool && tool.role === "tool") toolResults.push(JSON.parse(tool.content));
      paso += 1;
      if (paso === 1) {
        return { text: "", toolCalls: [{ id: "c1", name: "cotizar_pedido", argumentsJson: JSON.stringify({ branch_slug: "fco-montejo", items: [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }] }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      }
      return { text: "El pedido mínimo a domicilio es de $200.", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    const turn = await handler.handleInboundMessage({ organizationId: f.organizationId, phone: "+5219997654321", messages: mensajes, customer: { isNew: true }, propertyId: f.propertyId });
    expect(turn.orderId).toBeNull();
    expect((toolResults[0] as { error: string }).error).toContain("El pedido mínimo a domicilio en Francisco de Montejo es de $200");
  });
});

describe("branchChannelRules", () => {
  it("nombra la sucursal y su slug", () => {
    expect(branchChannelRules({ name: "Pensiones", slug: "pensiones" })).toContain('"Pensiones" (branch_slug: "pensiones")');
  });
});
