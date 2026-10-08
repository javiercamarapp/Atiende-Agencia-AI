// QA-PM-R5 (afirmaciones del juez T7-060, T7-010, T7-013):
//  - T7-060: «Permítame verificarlo con una persona de la sucursal» sin escalar_a_humano: nadie recibia nada. Ahora es una promesa de aviso como «ya avisé al gerente»: el servidor deja
//    el aviso de verdad (o quita la frase si no puede).
//  - T7-010 / T7-013: el cliente se despedia («solo quería saber si estaban abiertos, gracias») y el servidor le anexaba «¿Qué le gustaría pedir?» a CADA turno, ocho veces seguidas.
// Cada guarda con regex sobre texto de clientes o del modelo lleva casos NEGATIVOS (futuro, condicional, negacion, pregunta, historial).
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { afirmaHaberAvisado, enforcePendingQuestion, esDespedidaDelCliente } from "../src/whatsapp/guards.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

type Script = (request: LlmCompletionRequest) => LlmCompletionResult;
const texto = (text: string): LlmCompletionResult => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });
function handlerGuionado(repo: InMemoryRestaurantesRepository, script: Script) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "guion", script })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "esc", script })]);
  return createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
}
const PHONE = "+5219990002222";
const entrada = (organizationId: string, contenido: string) => ({ organizationId, phone: PHONE, messages: [{ role: "user" as const, content: contenido }], customer: { isNew: true as const }, propertyId: null });

describe("T7-060: afirmaHaberAvisado reconoce la promesa de consultar con una persona", () => {
  it("la frase literal del juez y sus variantes cuentan", () => {
    for (const t of [
      "Permítame verificarlo con una persona de la sucursal, ya que no puedo confirmar el precio del kilo de pastor con la información disponible.",
      "Permítame consultarlo con el gerente.",
      "Déjeme confirmarlo con el equipo y le respondo.",
      "Voy a verificarlo con una persona de la sucursal.",
      "Lo consulto con el gerente y le digo.",
      "Lo reviso con alguien de la sucursal.",
    ]) expect(afirmaHaberAvisado(t), t).toBe(true);
  });

  it("NEGATIVOS: pregunta, condicional, ofrecimiento, negacion, subjuntivo, imperativo e historial no cuentan", () => {
    for (const t of [
      "¿Desea que lo verifique con una persona de la sucursal?",
      "Si gusta, lo consulto con el gerente.",
      "Si quiere puedo consultarlo con el equipo.",
      "No puedo verificarlo con una persona desde aquí.",
      "No lo consulto con el gerente porque el precio es el del menú.",
      "Para que lo verifique con una persona necesito su nombre.",
      "Podría consultarlo con el gerente, pero primero dígame qué desea.",
      "Cuando lo consulte con el equipo le aviso.",
      "El precio del kilo de pastor es $900 y ya lo verificamos en el menú.",
      "Consulte con el equipo de la sucursal si tiene dudas.",
      "Le recomiendo confirmar con la sucursal el horario de mañana.",
      "Ayer lo consultó con el gerente, según su historial.",
    ]) expect(afirmaHaberAvisado(t), t).toBe(false);
  });

  it("no cambia lo que ya contaba ni lo que ya no contaba (avisos de preparacion)", () => {
    expect(afirmaHaberAvisado("Ya avisé al gerente.")).toBe(true);
    expect(afirmaHaberAvisado("Voy a avisar a la sucursal para que tenga listo su pedido.")).toBe(false);
  });
});

describe("T7-060: el aviso prometido existe en la base", () => {
  it("'Permítame verificarlo con una persona de la sucursal' sin herramienta deja el aviso de verdad", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("Permítame verificarlo con una persona de la sucursal, ya que no puedo confirmar el precio del kilo de pastor con la información disponible."));
    const out = await handler.handleInboundMessage(entrada(f.organizationId, "¿Me podrían confirmar el precio del pastor?"));
    expect(out.escalacion?.motivo).toBe("otro");
    const avisos = await f.repo.listCallbackRequests(f.organizationId);
    expect(avisos.filter((a) => (a.reason ?? "").startsWith("escalada:otro"))).toHaveLength(1);
  });

  it("negativo: 'Si gusta, lo consulto con el gerente' (ofrecimiento) NO deja ningun aviso", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("El kilo de pastor cuesta $900. Si gusta, lo consulto con el gerente."));
    await handler.handleInboundMessage(entrada(f.organizationId, "¿Cuánto cuesta el kilo de pastor?"));
    expect(await f.repo.listCallbackRequests(f.organizationId)).toHaveLength(0);
  });
});

describe("T7-010 / T7-013: esDespedidaDelCliente", () => {
  it("las despedidas reales del juez cuentan", () => {
    for (const m of [
      "Ah, solo quería saber si estaban abiertos, gracias 😊",
      "No, gracias, solo quería confirmar el horario.",
      "No gracias, solo quería confirmar. ¡Buenas noches!",
      "Nada más, gracias 😊",
      "Nada más, muchas gracias 😊",
      "Gracias, igualmente 😊",
      "Nada, gracias 😊",
      "fin",
      "Hasta luego, gracias",
      "Eso es todo, gracias",
      "¡Buena tarde! Nada más, gracias.",
    ]) expect(esDespedidaDelCliente(m), m).toBe(true);
  });

  it("NEGATIVOS: saludo, aceptacion, pregunta, pedido, cifras y respuestas a una oferta no son despedida", () => {
    for (const m of [
      "Buenas tardes",
      "Hola, buenas noches",
      "Sí, gracias",
      "si gracias",
      "Claro, gracias",
      "ok",
      "gracias, quiero 3 tacos de pastor",
      "No gracias, ¿cuánto sale el total?",
      "Gracias, ¿están abiertos?",
      "no gracias, sin cebolla",
      "Nada más, 2 coca colas",
      "Gracias por la información, mándame el menú",
      "Ahorita le mando mi dirección, gracias",
      "No gracias, pero quiero cambiar el pago a tarjeta",
      "No gracias a la promoción, mejor agrégame unas salsas",
      "",
      "   ",
    ]) expect(esDespedidaDelCliente(m), m).toBe(false);
    expect(esDespedidaDelCliente(undefined)).toBe(false);
  });
});

describe("T7-010 / T7-013: enforcePendingQuestion no repregunta tras la despedida", () => {
  const RESPUESTA = "Con gusto, sí estamos abiertos. ¡Gracias por escribirnos! 😊";

  it("con despedida del cliente la respuesta queda tal cual (sin '¿Qué le gustaría pedir?')", () => {
    expect(enforcePendingQuestion(RESPUESTA, true, null, "Ah, solo quería saber si estaban abiertos, gracias 😊")).toBe(RESPUESTA);
    expect(enforcePendingQuestion(RESPUESTA, false, null, "Nada más, gracias 😊")).toBe(RESPUESTA);
  });

  it("SIN despedida (o sin mensaje del cliente) sigue anexando la pregunta del paso pendiente, como siempre", () => {
    expect(enforcePendingQuestion(RESPUESTA, true, null, "Hola, ¿aún están disponibles?")).toBe(`${RESPUESTA} ¿Qué le gustaría pedir, o hay algo más en lo que le pueda ayudar?`);
    expect(enforcePendingQuestion(RESPUESTA, true, null)).toContain("¿Qué le gustaría pedir");
    expect(enforcePendingQuestion("Con gusto.", false, null, "Buenas tardes")).toContain("colonia");
  });

  it("una respuesta que ya pregunta no se toca, con o sin despedida", () => {
    expect(enforcePendingQuestion("¿Algo más?", true, null, "Hola")).toBe("¿Algo más?");
  });

  it("de punta a punta: tras 'Nada más, gracias' el agente NO vuelve a ofrecer pedir; tras un saludo si", async () => {
    const f = buildRestaurantFixture();
    const handler = handlerGuionado(f.repo, () => texto("¡Con gusto! Que tenga una excelente noche. 😊"));
    const despedida = await handler.handleInboundMessage(entrada(f.organizationId, "Nada más, gracias 😊"));
    expect(despedida.reply).not.toMatch(/qu[eé] le gustar[ií]a pedir/i);
    const saludo = await handler.handleInboundMessage(entrada(f.organizationId, "Hola, buenas noches"));
    expect(saludo.reply).toMatch(/qu[eé] le gustar[ií]a pedir|colonia/i);
  });
});
