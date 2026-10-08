// QA-PM-R4-whatsapp-01: un "???" o un "quiero una persona... bueno no, mejor sigo contigo" no cede la conversacion a una persona:
// la toma de handoff callaba al agente y el pedido en curso se perdia en silencio.
import { describe, expect, it } from "vitest";
import { abreTomaDeHandoff, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { pideUnaPersona } from "../src/whatsapp/guards.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const u = (content: string) => ({ role: "user" as const, content });

describe("pideUnaPersona: retractacion en el mismo mensaje", () => {
  it.each([
    "quiero hablar con una persona... bueno no, mejor sigo contigo: 4 tacos de pastor para recoger",
    "pasame con el gerente, no mejor sigo aqui contigo",
    "quiero una persona. ya no, gracias, sigo contigo",
  ])("%s -> no pide persona", (t) => {
    expect(pideUnaPersona(t)).toBe(false);
  });
  it.each(["quiero hablar con una persona", "quiero 3 tacos y que me hable una persona", "pasame con el gerente por favor, mejor dicho ya"])("%s -> si pide persona", (t) => {
    expect(pideUnaPersona(t)).toBe(true);
  });
});

describe("abreTomaDeHandoff", () => {
  it("cliente_lo_pide sin peticion real (???) no abre toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("hola"), u("???"), u("alguien me atiende??")])).toBe(false);
  });
  it("cliente_lo_pide con peticion real abre toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("quiero hablar con una persona")])).toBe(true);
  });
  it("retractacion: no abre toma", () => {
    expect(abreTomaDeHandoff("cliente_lo_pide", [u("quiero hablar con una persona... bueno no, mejor sigo contigo: 4 tacos de pastor")])).toBe(false);
  });
  it("los demas motivos conservan su regla", () => {
    expect(abreTomaDeHandoff("queja", [u("???")])).toBe(true);
    expect(abreTomaDeHandoff("tiempos_entrega", [u("???")])).toBe(false);
  });
});

describe("handleInboundWhatsAppMessage: el agente sigue atendiendo tras un falso positivo de persona", () => {
  it("escalacion cliente_lo_pide por '???' no abre toma y el siguiente mensaje recibe respuesta", async () => {
    const fixture = buildRestaurantFixture();
    const PHONE = "+5219991234567";
    const store = new InMemoryConversacionesRepository({ actorUserId: "00000000-0000-4000-8000-0000000000f1" });
    const gate = new InMemoryHandoffAgentGate(store);
    const propertyId = "00000000-0000-4000-8000-0000000000a1";
    store.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: fixture.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    let turnos = 0;
    const handler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnos += 1;
        return { reply: "Con calma, la sucursal ya fue avisada", orderId: null, propertyId: null, ...(turnos === 1 ? { escalacion: { motivo: "cliente_lo_pide" } } : {}) };
      },
    };
    const enviar = (messageId: string, body: string) => handleInboundWhatsAppMessage(fixture.repo, handler, { organizationId: fixture.organizationId, messageId, phone: PHONE, body, phoneNumberId: "1", propertyId, handoffGate: gate });
    const primero = await enviar("m1", "???");
    expect(primero).toMatchObject({ ok: true, escalated: false });
    expect(store.handoffs).toHaveLength(0);
    const segundo = await enviar("m2", "quiero 4 tacos de pastor para recoger");
    expect(segundo).toMatchObject({ ok: true, reply: "Con calma, la sucursal ya fue avisada" });
    expect(turnos).toBe(2);
  });
});
