// Fase 2 hoteles §2 — unidad del loop de tool-use del agente de WhatsApp
// (`createLlmHotelesWhatsAppTurnHandler`). El flujo HTTP completo con tool-use real
// de punta a punta vive en apps/api/tests/hoteles-whatsapp-llm-agent.spec.ts — aquí
// se cubren los caminos que ese test E2E no ejercita: la guardia REQ-AB-004 (nunca
// se expone un parámetro de "seguridad asegurada"), la escalada de rol tras un fallo
// real de herramienta, el loop agotado, y el catálogo reducido a 2 tools (diseño §5.2).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmHotelesWhatsAppTurnHandler, TOOLS } from "../../src/whatsapp/llm-turn-handler.ts";
import { InMemoryHotelesRepository } from "../../src/in-memory-repository.ts";

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

function baseRepoAndIds() {
  const repo = new InMemoryHotelesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  return { repo, organizationId, propertyId };
}

describe("TOOLS — catálogo (Fase 2 §5.2 + Fase 6 REQ-HK-011)", () => {
  it("expone crear_ticket_huesped_fnb, crear_ticket_mantenimiento y registrar_contacto_no_operativo — nunca housekeeping (turnos)/dinero/plantillas", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["crear_ticket_huesped_fnb", "crear_ticket_mantenimiento", "registrar_contacto_no_operativo"]);
  });
});

describe("createLlmHotelesWhatsAppTurnHandler — el loop de tool-use", () => {
  it("una respuesta SIN tool calls termina el turno de inmediato con esa respuesta", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => ({ text: "¡Hola! ¿En qué te ayudo?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }] });

    expect(result.reply).toBe("¡Hola! ¿En qué te ayudo?");
    expect(result.fnbOrderId).toBeNull();
  });

  it("REQ-AB-004: un pedido con alergia declarada se crea marcado, y el ticket devuelto NUNCA afirma que es seguro", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "",
          toolCalls: [{ id: "c1", name: "crear_ticket_huesped_fnb", argumentsJson: JSON.stringify({ mensaje: "Quiero un club sandwich, soy alérgico a los mariscos", habitacion: "305", alergia_declarada: true }) }],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 1 });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "quiero un club sandwich" }] });

    expect(result.fnbOrderId).not.toBeNull();
    const order = await repo.findFnbOrder(propertyId, result.fnbOrderId!);
    expect(order).not.toBeNull();
    expect(order!.allergyDeclared).toBe(true);
    expect(order!.kitchenConfirmedBy).toBeNull(); // sin confirmación humana todavía.
    // La única función de dominio que puede "asegurar seguridad" (assertCanAssureDishIsSafe)
    // ni siquiera es alcanzable desde este canal — el tool nunca expone ese parámetro.
    expect(order!.safetyAssuranceSentAt).toBeNull();
    expect(order!.createdBy).toBeNull(); // actor system:whatsapp, sin staff humano.
  });

  it("una alergia mencionada en texto libre sin el flag estructurado también queda marcada (fail-closed, mismo camino que la ruta de staff)", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "",
          toolCalls: [{ id: "c1", name: "crear_ticket_huesped_fnb", argumentsJson: JSON.stringify({ mensaje: "Una ensalada, soy celiaco" }) }],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 1 });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "una ensalada, soy celiaco" }] });

    const order = await repo.findFnbOrder(propertyId, result.fnbOrderId!);
    expect(order!.allergyDeclared).toBe(true);
    expect(order!.allergyDeclaredVia).toBe("texto_libre");
  });

  it("un mensaje que no es de F&B se deriva a registrar_contacto_no_operativo — nunca crea un ticket de F&B", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "",
          toolCalls: [{ id: "c1", name: "registrar_contacto_no_operativo", argumentsJson: JSON.stringify({ motivo: "queja_ruido", resumen: "Se queja del ruido del piso de arriba" }) }],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 2 });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "el piso de arriba hace mucho ruido" }] });

    expect(result.fnbOrderId).toBeNull();
    const orders = await repo.listFnbOrders(propertyId);
    expect(orders).toHaveLength(0);
  });

  it("si mensaje viene vacío, crear_ticket_huesped_fnb falla y el turno siguiente escala al modelo caro (nunca reintenta en silencio en el mismo modelo barato)", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    let step = 0;
    const defaultCalls: string[] = [];
    const escalatedCalls: string[] = [];
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          defaultCalls.push("default");
          const current = step++;
          if (current === 0) {
            return { text: "", toolCalls: [{ id: "c1", name: "crear_ticket_huesped_fnb", argumentsJson: JSON.stringify({ mensaje: "" }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
          }
          throw new Error("el rol default no debería volver a llamarse tras el fallo de la herramienta");
        },
      }),
    ]);
    gateway.registerLadder("escalated", [
      new FakeLlmProvider({
        id: "e",
        script: () => {
          escalatedCalls.push("escalated");
          return { text: "¿Me puedes repetir qué te gustaría pedir?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "quiero algo de comer" }] });

    expect(defaultCalls).toHaveLength(1);
    expect(escalatedCalls).toHaveLength(1);
    expect(result.reply).toMatch(/repetir/i);
  });

  it("si el loop se agota sin haber creado un ticket, responde el mensaje genérico, nunca un 500 crudo", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    const neverEndingToolCall = (): LlmCompletionResult => ({
      text: "",
      toolCalls: [{ id: randomUUID(), name: "registrar_contacto_no_operativo", argumentsJson: JSON.stringify({ motivo: "x" }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    });
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: neverEndingToolCall })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e", script: neverEndingToolCall })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 2 });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }] });

    expect(result.fnbOrderId).toBeNull();
    expect(result.reply).toMatch(/se me complicó/i);
  });

  it("si toda la escalera de proveedores falla, responde con el mensaje de problema técnico, nunca lanza", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", failWith: () => Object.assign(new Error("caído"), { status: 503 }) })]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }] });

    expect(result.fnbOrderId).toBeNull();
    expect(result.reply).toMatch(/problema técnico/i);
  });

  it("REQ-HK-011: un reporte de un problema físico crea un ticket de mantenimiento por WhatsApp (actor system:whatsapp, sin staff logueado)", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => ({
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "crear_ticket_mantenimiento",
              argumentsJson: JSON.stringify({ titulo: "Aire acondicionado no enfría", descripcion: "Lleva 2 horas sin enfriar", habitacion: "410", severidad: "media" }),
            },
          ],
          model: "fake",
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        }),
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", maxToolUseTurns: 1 });

    await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "el aire no enfría" }] });

    const tickets = await repo.listMaintenanceTickets(propertyId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.title).toBe("Aire acondicionado no enfría");
    expect(tickets[0]!.severity).toBe("media");
    expect(tickets[0]!.origin).toBe("huesped");
    expect(tickets[0]!.createdBy).toBeNull();
    expect(tickets[0]!.description).toContain("410");
  });

  it("si titulo/descripcion vienen vacíos, crear_ticket_mantenimiento falla y el turno siguiente escala al modelo caro (mismo criterio que crear_ticket_huesped_fnb)", async () => {
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    let step = 0;
    const defaultCalls: string[] = [];
    const escalatedCalls: string[] = [];
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          defaultCalls.push("default");
          const current = step++;
          if (current === 0) {
            return { text: "", toolCalls: [{ id: "c1", name: "crear_ticket_mantenimiento", argumentsJson: JSON.stringify({ titulo: "", descripcion: "" }) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
          }
          throw new Error("el rol default no debería volver a llamarse tras el fallo de la herramienta");
        },
      }),
    ]);
    gateway.registerLadder("escalated", [
      new FakeLlmProvider({
        id: "e",
        script: () => {
          escalatedCalls.push("escalated");
          return { text: "¿Me puedes describir de nuevo el problema?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "algo está roto" }] });

    expect(defaultCalls).toHaveLength(1);
    expect(escalatedCalls).toHaveLength(1);
    expect(result.reply).toMatch(/describir/i);
    expect(await repo.listMaintenanceTickets(propertyId)).toHaveLength(0);
  });

  it("un argumentsJson mal formado en una tool call NO tracked para escalación se maneja como un resultado de error, sin tirar el turno completo", async () => {
    // Usa registrar_contacto_no_operativo (no crear_ticket_huesped_fnb/crear_ticket_mantenimiento) a
    // propósito: solo el fallo de esas dos tools dispara huboFalloDeHerramienta, así
    // este caso aísla "JSON mal formado se maneja sin tirar" de "escala al modelo caro".
    const { repo, organizationId, propertyId } = baseRepoAndIds();
    const gateway = makeGateway();
    let step = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: () => {
          const current = step++;
          if (current === 0) {
            return { text: "", toolCalls: [{ id: "c1", name: "registrar_contacto_no_operativo", argumentsJson: "{not valid json" }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
          }
          return { text: "Perdón, ¿me repites tu pedido?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmHotelesWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "algo de comer" }] });

    expect(result.reply).toBe("Perdón, ¿me repites tu pedido?");
  });
});
