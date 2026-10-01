// El agente de WhatsApp deja de responder cuando un humano tiene la conversacion, y pide un humano cuando el
// turno lo escala (`escalar_a_humano`). Contra el repositorio en memoria del dominio.
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219991234567";
const STAFF = "00000000-0000-4000-8000-0000000000f1";

function setup() {
  const fixture = buildRestaurantFixture();
  const store = new InMemoryConversacionesRepository({ actorUserId: STAFF });
  const gate = new InMemoryHandoffAgentGate(store);
  let turnos = 0;
  let escalar = false;
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos += 1;
      return { reply: "Respuesta del agente", orderId: null, propertyId: null, ...(escalar ? { escalacion: { motivo: "queja" } } : {}) };
    },
  };
  const propertyId = "00000000-0000-4000-8000-0000000000a1";
  const convId = "00000000-0000-4000-8000-0000000000c1";
  store.conversaciones.push({ canal: "whatsapp", id: convId, organizationId: fixture.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
  const enviar = (messageId: string, body: string) =>
    handleInboundWhatsAppMessage(fixture.repo, turnHandler, { organizationId: fixture.organizationId, messageId, phone: PHONE, body, phoneNumberId: "1", propertyId, handoffGate: gate });
  return { fixture, store, gate, enviar, propertyId, convId, turnos: () => turnos, setEscalar: (v: boolean) => (escalar = v) };
}

describe("handleInboundWhatsAppMessage con handoff", () => {
  it("sin toma abierta el agente responde como siempre", async () => {
    const t = setup();
    const out = await t.enviar("m1", "Hola");
    expect(out).toMatchObject({ ok: true, reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("con la conversacion TOMADA por un humano el agente calla, pero el mensaje del cliente queda guardado", async () => {
    const t = setup();
    await t.store.tomar(t.fixture.organizationId, t.propertyId, "whatsapp", t.convId);
    const out = await t.enviar("m2", "Sigo esperando");
    expect(out).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
    const msgs = await t.fixture.repo.appendWhatsAppUserMessageOnce(t.fixture.organizationId, PHONE, { role: "user", content: "probe" });
    expect(msgs.map((m) => m.content)).toEqual(["Sigo esperando", "probe"]);
    expect(msgs.some((m) => m.role === "assistant")).toBe(false);
  });

  it("devuelta al agente, responde de nuevo", async () => {
    const t = setup();
    const id = await t.store.tomar(t.fixture.organizationId, t.propertyId, "whatsapp", t.convId);
    await t.store.devolver(t.fixture.organizationId, t.propertyId, id);
    expect(await t.enviar("m3", "Gracias")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("si el turno escala (`escalar_a_humano`) se abre una toma PENDIENTE y los mensajes siguientes ya no los atiende el agente", async () => {
    const t = setup();
    t.setEscalar(true);
    await t.enviar("m4", "Quiero hablar con alguien");
    const h = t.store.handoffs.find((x) => x.conversationId === t.convId)!;
    expect(h).toMatchObject({ estado: "pendiente", solicitadoPor: "agente", motivo: "queja" });
    expect(t.turnos()).toBe(1);
    t.setEscalar(false);
    await t.enviar("m5", "Hola?");
    expect(t.turnos()).toBe(1); // el agente no volvio a correr
    expect(h.ultimoClienteAt).not.toBeNull(); // el ping alimenta la escalacion
  });

  it("sin handoffGate (camino anterior) nada cambia", async () => {
    const t = setup();
    await t.store.tomar(t.fixture.organizationId, t.propertyId, "whatsapp", t.convId);
    const turnHandler: WhatsAppTurnHandler = { handleInboundMessage: async () => ({ reply: "ok", orderId: null, propertyId: null }) };
    const out = await handleInboundWhatsAppMessage(t.fixture.repo, turnHandler, { organizationId: t.fixture.organizationId, messageId: "m6", phone: PHONE, body: "x", phoneNumberId: "1" });
    expect(out.reply).toBe("ok");
  });
});
