// R-44 -- agente en INGLES por WhatsApp: los guardias deterministas (alto riesgo, pregunta pendiente, aviso de bistec, textos fijos) y el
// prompt funcionan igual en los dos idiomas. Antes de R-44 un cliente que escribia "I want to cancel my order" o "I'm allergic to peanuts"
// NO disparaba el clasificador de alto riesgo (solo conocia espanol) y el modelo decidia solo.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { buildSystemPrompt, createLlmWhatsAppTurnHandler, enforceBistecPackNotice, FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, providerFailureReply, saludoSegunHora } from "../src/whatsapp/llm-turn-handler.ts";
import { classifyHighRiskIntent, enforcePendingQuestion, enforceQuotedTotal, matchesHighRiskOtherThan } from "../src/whatsapp/guards.ts";
import { privacyNoticeWhatsApp, PRIVACY_CONFIG_POR_DEFECTO } from "../src/privacidad/aviso.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

function handlerGuionado(repo: InMemoryRestaurantesRepository, script: (r: LlmCompletionRequest) => LlmCompletionResult) {
  const provider = new FakeLlmProvider({ id: "guion", script });
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  return { handler: createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", now: () => new Date("2026-03-10T19:00:00Z") }), provider };
}

const PHONE = "+5219990001111";
const entrada = (organizationId: string, contenido: string, previos: Array<{ role: "user" | "assistant"; content: string }> = []) => ({
  organizationId,
  phone: PHONE,
  messages: [...previos, { role: "user" as const, content: contenido }],
  customer: { isNew: true as const },
  propertyId: null,
});

// Texto en espanol que NO debe aparecer en una respuesta fija en ingles.
const ESPANOL = /\b(?:Ya avis[eé]|Lamento|equipo del restaurante|usted|su pedido)\b/i;

describe("R-44 motivos de alto riesgo en ingles: se avisan al equipo ANTES del modelo, con respuesta fija en ingles", () => {
  const casos: Array<[string, string, string, string]> = [
    ["queja", "My order arrived cold and it was missing a drink", "queja", "can't promise a replacement"],
    ["cancelacion", "I want to cancel my order", "cancelacion_modificacion", "Only someone at the restaurant can confirm"],
    ["cobro duplicado", "You charged me twice for the same order", "cobro_duplicado", "review your case"],
    ["urgencia", "It's urgent, I need it now", "urgencia", "it's urgent"],
    ["ARCO", "Please delete my personal data", "privacidad_arco", "exercise your data rights"],
    ["persona", "I want to speak to a manager", "cliente_lo_pide", "a person can contact you"],
    ["alergia", "I'm allergic to peanuts, does it have any?", "alergia_salud", "can't guarantee the ingredients"],
    ["transferencia", "Can I pay by bank transfer?", "transferencia", "cash or card"],
  ];
  for (const [nombre, mensaje, motivo, fragmento] of casos) {
    it(`${nombre}: '${mensaje}' escala '${motivo}' sin llamar al modelo y responde en ingles`, async () => {
      const f = buildRestaurantFixture();
      const spy = vi.spyOn(f.repo, "createCallbackRequest");
      const { handler, provider } = handlerGuionado(f.repo, () => texto("NO DEBERIA LLAMARSE"));
      const turn = await handler.handleInboundMessage(entrada(f.organizationId, mensaje));
      expect(provider.callCount).toBe(0);
      expect(turn.orderId).toBeNull();
      expect(turn.reply).toContain(fragmento);
      expect(turn.reply).not.toMatch(ESPANOL);
      expect(spy).toHaveBeenCalledTimes(1);
      // El motivo que lee el equipo es el mismo valor tipificado que en espanol.
      expect(spy.mock.calls[0]![0]).toMatchObject({ customerPhone: PHONE, reason: `escalada:${motivo}`, source: "whatsapp" });
      expect((turn as { escalacion?: { motivo: string } }).escalacion).toEqual({ motivo });
    });
  }

  it("el mismo motivo en espanol sigue respondiendo en espanol (sin regresion)", () => {
    expect(classifyHighRiskIntent("Quiero cancelar mi pedido")?.reply).toContain("solo lo puede confirmar alguien del restaurante");
    expect(classifyHighRiskIntent("Soy alérgico al cacahuate")?.reply).toContain("no puedo asegurarle los ingredientes");
  });

  it("un mensaje en ingles pero con el idioma de la conversacion en espanol responde segun el idioma indicado", () => {
    expect(classifyHighRiskIntent("cancel my order", "es")?.reply).toContain("solo lo puede confirmar");
    expect(classifyHighRiskIntent("cancelar mi pedido", "en")?.reply).toContain("Only someone at the restaurant");
  });

  it("un pedido normal en ingles NO se intercepta (sin falsos positivos con lenguaje de pedido)", () => {
    for (const frase of [
      "I'd like 8 al pastor tacos for pickup",
      "no onions please and extra pineapple",
      "for pickup, under the name Marcela",
      "How long does delivery take?",
      "Can I get an order of beans?",
      "What time do you open today?",
      "my order is for the Altabrisa branch",
      "yes, corn tortilla for all of them",
      "I pay with card",
    ]) {
      expect(classifyHighRiskIntent(frase), frase).toBeNull();
    }
  });

  it("matchesHighRiskOtherThan ve los motivos en ingles (para que ARCO no robe un mensaje con alergia)", () => {
    expect(matchesHighRiskOtherThan("Delete my personal data, I'm also allergic to nuts", "privacidad_arco")).toBe(true);
    expect(matchesHighRiskOtherThan("Please delete my personal data", "privacidad_arco")).toBe(false);
  });
});

describe("R-44 guardias post-LLM en ingles", () => {
  it("una respuesta sin pregunta recibe la pregunta pendiente en ingles (y en espanol por omision)", () => {
    expect(enforcePendingQuestion("Sure thing.", false, null, "en")).toBe("Sure thing. Could you share your neighborhood or a nearby landmark so I can find the closest branch?");
    expect(enforcePendingQuestion("Sure thing.", true, null, "en")).toBe("Sure thing. What would you like to order, or is there anything else I can help you with?");
    expect(enforcePendingQuestion("Claro.", true, null)).toBe("Claro. ¿Qué le gustaría pedir, o hay algo más en lo que le pueda ayudar?");
    expect(enforcePendingQuestion("Anything else?", true, null, "en")).toBe("Anything else?");
    expect(enforcePendingQuestion("Done.", true, "order-1", "en")).toBe("Done.");
  });

  it("el total que lee el cliente sigue siendo el real aunque el modelo lo escriba en ingles", () => {
    expect(enforceQuotedTotal("Your total is $350, shall I confirm?", 90)).toBe("Your total is $90.00, shall I confirm?");
    expect(enforceQuotedTotal("The total comes to 350 pesos", 90)).toBe("The total comes to $90.00");
  });

  it("aviso de 'orden de 3' para tacos de bistec en ingles, sin duplicarlo", () => {
    const user = [{ role: "user" as const, content: "I want 6 steak tacos" }];
    expect(enforceBistecPackNotice("Of course, how many?", user, "en")).toMatch(/^Steak \(bistec\) tacos are sold only in orders of 3/);
    expect(enforceBistecPackNotice("Steak tacos come in orders of 3, how many orders?", user, "en")).toBe("Steak tacos come in orders of 3, how many orders?");
    expect(enforceBistecPackNotice("Claro, ¿cuántos?", [{ role: "user" as const, content: "quiero tacos de bistec" }])).toMatch(/únicamente en órdenes de 3/);
  });

  it("textos fijos de falla en ingles y en espanol", () => {
    expect(providerFailureReply("o1", "taqueria_pm", "en")).toBe("Your order has been registered and sent to the kitchen.");
    expect(providerFailureReply(null, "generico", "en")).toContain("technical problem");
    expect(providerFailureReply(null, "taqueria_pm")).toContain("problema técnico");
  });

  it("saludo por hora en ingles calculado por el servidor", () => {
    expect(saludoSegunHora("America/Merida", new Date("2026-03-10T14:00:00Z"), "en")).toBe("Good morning");
    expect(saludoSegunHora("America/Merida", new Date("2026-03-10T19:00:00Z"), "en")).toBe("Good afternoon");
    expect(saludoSegunHora("America/Merida", new Date("2026-03-11T02:00:00Z"), "en")).toBe("Good evening");
    expect(saludoSegunHora("America/Merida", new Date("2026-03-10T14:00:00Z"))).toBe("Buenos días");
  });
});

describe("R-44 el prompt y el turno completo en ingles", () => {
  const ahora = new Date("2026-03-10T19:00:00Z");

  it("el prompt trae las reglas de idioma y el bloque del idioma actual (ingles / espanol) en los dos perfiles", () => {
    for (const config of [FALLBACK_CONFIG, PM_CONFIG_POR_OMISION]) {
      const en = buildSystemPrompt(config, [], { isNew: true }, ahora, null, "en");
      const es = buildSystemPrompt(config, [], { isNew: true }, ahora, null);
      expect(en).toContain("IDIOMA ACTUAL DE ESTA CONVERSACIÓN: inglés");
      expect(en).toContain("Good afternoon");
      expect(en).toContain("Los valores que usted manda a las herramientas NO se traducen");
      expect(es).toContain("IDIOMA ACTUAL DE ESTA CONVERSACIÓN: español");
      expect(es).toContain("Buenas tardes");
      expect(es).not.toContain("Good afternoon");
    }
  });

  it("en ingles el saludo propio del negocio (escrito en espanol) no se usa; en espanol si", () => {
    const config = { ...PM_CONFIG_POR_OMISION, greetingText: "Quiubole, bienvenido" };
    expect(buildSystemPrompt(config, [], { isNew: true }, ahora, null, "en")).not.toContain("Quiubole");
    expect(buildSystemPrompt(config, [], { isNew: true }, ahora, null, "es")).toContain("Quiubole");
  });

  it("un cliente que escribe en ingles recibe el prompt en ingles y la pregunta pendiente en ingles", async () => {
    const f = buildRestaurantFixture();
    let sistema = "";
    const { handler } = handlerGuionado(f.repo, (req) => {
      sistema = req.system ?? "";
      return texto("Welcome! I'm the virtual assistant.");
    });
    const turn = await handler.handleInboundMessage(entrada(f.organizationId, "Hello, I would like to order some tacos please"));
    expect(sistema).toContain("IDIOMA ACTUAL DE ESTA CONVERSACIÓN: inglés");
    expect(turn.reply).toContain("Welcome!");
    expect(turn.reply).toMatch(/(?:neighborhood or a nearby landmark|What would you like to order)/);
    expect(turn.reply).not.toMatch(/¿/);
  });

  it("un mensaje ambiguo ('tacos al pastor') a mitad de una charla en ingles conserva el ingles", async () => {
    const f = buildRestaurantFixture();
    let sistema = "";
    const { handler } = handlerGuionado(f.repo, (req) => {
      sistema = req.system ?? "";
      return texto("Got it, anything else?");
    });
    await handler.handleInboundMessage(
      entrada(f.organizationId, "tacos al pastor", [
        { role: "user", content: "Hello, I would like to order for pickup please" },
        { role: "assistant", content: "Good afternoon! Which branch would you like?" },
      ]),
    );
    expect(sistema).toContain("IDIOMA ACTUAL DE ESTA CONVERSACIÓN: inglés");
  });

  it("una charla en espanol no cambia: prompt en espanol y sin ingles", async () => {
    const f = buildRestaurantFixture();
    let sistema = "";
    const { handler } = handlerGuionado(f.repo, (req) => {
      sistema = req.system ?? "";
      return texto("Claro, con gusto.");
    });
    const turn = await handler.handleInboundMessage(entrada(f.organizationId, "Buenas tardes, quiero hacer un pedido"));
    expect(sistema).toContain("IDIOMA ACTUAL DE ESTA CONVERSACIÓN: español");
    expect(turn.reply).toContain("Claro, con gusto.");
    expect(turn.reply).not.toMatch(/Could you|What would you like/);
  });
});

describe("R-44 aviso de privacidad en ingles", () => {
  it("el aviso en ingles dice asistente virtual (IA), retencion, ARCO y el integral; el de espanol no cambia", () => {
    const config = { ...PRIVACY_CONFIG_POR_DEFECTO, responsibleName: "Los Taquitos de PM", noticeUrl: "https://example.com/aviso" };
    const en = privacyNoticeWhatsApp(config, "en");
    expect(en).toContain("virtual assistant (an artificial intelligence) of Los Taquitos de PM");
    expect(en).toContain("180 days");
    expect(en).toContain("ARCO");
    expect(en).toContain("https://example.com/aviso");
    expect(en).not.toMatch(/\b(?:soy|días|aviso de privacidad)\b/i);
    expect(privacyNoticeWhatsApp(config)).toContain("Soy el asistente virtual (una inteligencia artificial) de Los Taquitos de PM");
    expect(privacyNoticeWhatsApp({ ...config, noticeUrl: null }, "en")).toContain("Ask the restaurant for the full privacy notice.");
  });
});
