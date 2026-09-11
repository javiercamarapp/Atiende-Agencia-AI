// Fase 2 §2 — unidad del loop de tool-use del agente de WhatsApp
// (`createLlmWhatsAppTurnHandler`) y de sus funciones puras portadas
// (`enforceBistecPackNotice`/`saludoSegunHora`). El flujo HTTP completo con
// tool-use real de punta a punta vive en
// apps/api/tests/whatsapp-llm-agent.spec.ts — aquí se cubren los caminos que
// ese test E2E no ejercita: respuesta sin tool calls, loop agotado sin éxito,
// loop agotado CON un pedido ya creado (bug real corregido en el origen),
// escalera de proveedores agotada, y las funciones puras en aislamiento.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult, LlmMessage } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler, enforceBistecPackNotice, saludoSegunHora } from "../../src/whatsapp/llm-turn-handler.ts";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import type { CustomerLookupResult } from "../../src/types.ts";

const NEW_CUSTOMER: CustomerLookupResult = { isNew: true };

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

function baseRepoAndOrg() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "org-test", name: "Org Test" });
  return { repo, organizationId };
}

describe("saludoSegunHora", () => {
  it("saluda según la hora real de la zona horaria dada, nunca un saludo fijo", () => {
    const manana = new Date("2026-03-10T14:00:00Z"); // 08:00 en America/Merida (UTC-6)
    const tarde = new Date("2026-03-10T19:00:00Z"); // 13:00
    const noche = new Date("2026-03-11T02:00:00Z"); // 20:00 (día anterior en UTC)
    expect(saludoSegunHora("America/Merida", manana)).toBe("Buenos días");
    expect(saludoSegunHora("America/Merida", tarde)).toBe("Buenas tardes");
    expect(saludoSegunHora("America/Merida", noche)).toBe("Buenas noches");
  });
});

describe("enforceBistecPackNotice", () => {
  const userMsg = (content: string): LlmMessage => ({ role: "user", content });

  it("agrega el aviso de 'orden de 3' cuando el cliente mencionó tacos de bistec y la respuesta no lo dice ya", () => {
    const reply = enforceBistecPackNotice("Claro, ¿cuántos quieres?", [userMsg("quiero tacos de bistec")]);
    expect(reply).toMatch(/únicamente en órdenes de 3/);
  });

  it("no duplica el aviso si la respuesta ya menciona 'ordenes de 3' (port literal del regex real del origen)", () => {
    const reply = enforceBistecPackNotice("Los tacos de bistec son por ordenes de 3, ¿cuántas quieres?", [userMsg("quiero tacos de bistec")]);
    expect(reply).not.toMatch(/únicamente en órdenes de 3/);
  });

  it("no toca la respuesta si el cliente no mencionó bistec", () => {
    const reply = enforceBistecPackNotice("Claro, ¿algo más?", [userMsg("quiero una coca")]);
    expect(reply).toBe("Claro, ¿algo más?");
  });
});

describe("createLlmWhatsAppTurnHandler — el loop de tool-use", () => {
  it("una respuesta SIN tool calls termina el turno de inmediato con esa respuesta", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const gateway = makeGateway();
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => ({ text: "¡Hola! ¿Qué se te antoja hoy?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER });

    expect(result.reply).toBe("¡Hola! ¿Qué se te antoja hoy?");
    expect(result.orderId).toBeNull();
    expect(result.propertyId).toBeNull();
  });

  it("si el loop se agota SIN haber creado un pedido, responde el mensaje genérico de 'se complicó', nunca un 500 crudo", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const gateway = makeGateway();
    const neverEndingToolCall = (): LlmCompletionResult => ({
      text: "",
      toolCalls: [{ id: randomUUID(), name: "registrar_contacto", argumentsJson: JSON.stringify({ customer_name: "X", reason: "test" }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: neverEndingToolCall })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: neverEndingToolCall })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 2 });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER });

    expect(result.orderId).toBeNull();
    expect(result.reply).toMatch(/se me complicó/i);
  });

  it("bug real corregido: si el loop se agota DESPUÉS de que crear_pedido ya tuvo éxito, confirma el pedido con éxito — nunca dice que 'se complicó'", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const propertyId = randomUUID();
    repo.seedBranch({ propertyId, organizationId, name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null });
    const catId = randomUUID();
    repo.seedCategory({ id: catId, organizationId, name: "Bebidas" });
    const productId = randomUUID();
    repo.seedProduct({ id: productId, organizationId, categoryId: catId, name: "Agua", description: null, searchKeywords: [] });
    repo.seedBranchProduct({ propertyId, productId, price: 20, isAvailable: true });

    const gateway = makeGateway();
    let step = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          const current = step++;
          if (current === 0) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "c1",
                  name: "crear_pedido",
                  argumentsJson: JSON.stringify({
                    branch_slug: "centro",
                    customer_name: "Cliente",
                    customer_address: "Calle 1",
                    items: [{ product_id: productId, product_name: "Agua", requested_quantity: 1 }],
                    payment_method: "efectivo",
                  }),
                },
              ],
              model: "fake",
              tokensIn: 1,
              tokensOut: 1,
              costUsd: 0,
            };
          }
          // Después del pedido ya creado, el "modelo" sigue queriendo llamar
          // tools indefinidamente (simula el bug real: agotar el loop tras el
          // éxito) — nunca debe volver a llamar crear_pedido.
          return { text: "", toolCalls: [{ id: `c${current + 1}`, name: "registrar_contacto", argumentsJson: JSON.stringify({ customer_name: "Cliente", reason: "otro" }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 3 });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "quiero un agua" }], customer: NEW_CUSTOMER });

    expect(result.orderId).not.toBeNull();
    expect(result.propertyId).toBe(propertyId);
    expect(result.reply).toMatch(/ya quedó registrado/i);
    expect(result.reply).not.toMatch(/se me complicó/i);

    // Nunca se duplicó el pedido real, aunque el "modelo" siguiera llamando tools.
    // normalizePhone("+5219990000000") -> últimos 10 dígitos.
    const customer = await repo.findCustomerByPhone(organizationId, "9990000000");
    expect(customer).not.toBeNull();
    const orders = await repo.listEligibleOrderHistory(customer!.id);
    expect(orders).toHaveLength(1);
  });

  it("si toda la escalera de proveedores falla, responde con el mensaje de problema técnico, nunca lanza", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const gateway = makeGateway();
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", failWith: () => Object.assign(new Error("caído"), { status: 503 }) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER });

    expect(result.orderId).toBeNull();
    expect(result.reply).toMatch(/problema técnico/i);
  });

  it("un argumentsJson mal formado en una tool call se maneja como un resultado de error, sin tirar el turno completo", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const gateway = makeGateway();
    let step = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          const current = step++;
          if (current === 0) {
            return { text: "", toolCalls: [{ id: "c1", name: "buscar_producto", argumentsJson: "{not valid json" }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
          }
          return { text: "Perdón, ¿me repites qué quieres?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "tacos" }], customer: NEW_CUSTOMER });

    expect(result.reply).toBe("Perdón, ¿me repites qué quieres?");
  });

  it("el bloque de sucursales del prompt se genera dinámicamente por organización — nunca texto fijo (generalización obligatoria multi-tenant)", async () => {
    const { repo, organizationId } = baseRepoAndOrg();
    const propertyId = randomUUID();
    repo.seedBranch({ propertyId, organizationId, name: "Sucursal Única de Prueba", slug: "sucursal-unica-xyz", status: "active", phone: null, address: "Dirección de prueba", lat: null, lng: null });

    const gateway = makeGateway();
    let capturedSystem = "";
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (request) => {
          capturedSystem = request.system;
          return { text: "ok", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }], customer: NEW_CUSTOMER });

    expect(capturedSystem).toContain("Sucursal Única de Prueba");
    expect(capturedSystem).toContain("sucursal-unica-xyz");
  });
});
