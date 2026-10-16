// PM R10 P4 (decision de Javier): la queja SIN detalle avisa al equipo y pregunta «¿qué faltó o qué llegó mal?» SIN callar al agente; el detalle que da el cliente se agrega al
// mismo aviso y ahi si se cede la conversacion a una persona (toma de handoff, R-21). Salud y quejas con detalle ceden de inmediato. Todo con modelo simulado.
import { describe, expect, it } from "vitest";
import { FakeLlmProvider, LlmGateway, CircuitBreaker, InMemoryCircuitBreakerStore, InMemoryBudgetLedgerStore } from "@atiende/agent-core";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import {
  QUEJA_DETALLE_RECIBIDO,
  QUEJA_PREGUNTA_DETALLE,
  QUEJA_PREGUNTA_MARCA,
  classifyHighRiskIntent,
  esperaDetalleDeQueja,
  noEsDetalleDeQueja,
  pideDineroDeVuelta,
  quejaTraeDetalle,
} from "../src/whatsapp/guards.ts";
import { evaluarPersonaVoz } from "../src/voz/guardia-persona.ts";
import { abreTomaDeHandoff, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219990001111";
const texto = (text: string) => ({ text, model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 });

function armar(modelo = "El modelo responde normal") {
  const f = buildRestaurantFixture();
  const provider = new FakeLlmProvider({ id: "guion", script: () => texto(modelo) });
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 } });
  gateway.registerLadder("default", [provider]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "sin-uso" })]);
  const handler = createLlmWhatsAppTurnHandler(f.repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });
  return { f, provider, handler };
}
const turno = (organizationId: string, contenido: string, previos: Array<{ role: "user" | "assistant"; content: string }> = []) => ({
  organizationId,
  phone: PHONE,
  messages: [...previos, { role: "user" as const, content: contenido }],
  customer: { isNew: true as const },
  propertyId: null,
});
const escalacion = (t: unknown) => (t as { escalacion?: { motivo: string } }).escalacion;
const avisos = (repo: InMemoryRestaurantesRepository, org: string) => repo.listCallbackRequests(org);
const preguntaPrevia = [{ role: "assistant" as const, content: QUEJA_PREGUNTA_DETALLE }];

describe("clasificadores puros de la queja en dos tiempos", () => {
  it.each(["quiero poner una queja", "tengo una queja", "pesimo servicio, queja"])("sin detalle: %s", (t) => expect(quejaTraeDetalle(t)).toBe(false));
  it.each(["me faltó la bebida de mi pedido", "llegó frío y faltó un agua", "mi pedido llegó incompleto", "no me llegó la coca de mi pedido", "vino todo frío mi pedido"])("con detalle: %s", (t) =>
    expect(quejaTraeDetalle(t)).toBe(true),
  );
  it("la pregunta fija lleva la marca, no promete reposicion ni descuento ni dinero", () => {
    expect(QUEJA_PREGUNTA_DETALLE).toContain(QUEJA_PREGUNTA_MARCA);
    expect(QUEJA_PREGUNTA_DETALLE).toMatch(/no puedo prometerle una reposición ni un descuento/);
    expect(QUEJA_PREGUNTA_DETALLE).not.toMatch(/reembols|devoluci/i);
    expect(esperaDetalleDeQueja([{ role: "user", content: "x" }, { role: "assistant", content: `Aviso de privacidad. ${QUEJA_PREGUNTA_DETALLE}` }, { role: "user", content: "falto algo" }])).toBe(true);
    expect(esperaDetalleDeQueja([{ role: "assistant", content: QUEJA_PREGUNTA_DETALLE }, { role: "user", content: "x" }, { role: "assistant", content: "Claro" }, { role: "user", content: "y" }])).toBe(false);
  });
  it.each(["quiero mi dinero de vuelta", "quiero un reembolso", "me devuelven el dinero?", "exijo la devolución"])("dinero: %s", (t) => expect(pideDineroDeVuelta(t)).toBe(true));
  it("«ya no» o un pedido nuevo no es el detalle", () => {
    expect(noEsDetalleDeQueja("ya no, gracias")).toBe(true);
    expect(noEsDetalleDeQueja("quiero pedir 3 tacos")).toBe(true);
    expect(noEsDetalleDeQueja("me faltó la salsa")).toBe(false);
  });
  it("voz: conserva su texto de siempre (sin la pregunta); la llamada cierra con una persona", () => {
    const voz = evaluarPersonaVoz("quiero una persona, tengo una queja");
    expect(voz?.motivo).toBe("queja");
    expect(voz?.texto).toBe(classifyHighRiskIntent("tengo una queja")?.reply);
    expect(voz?.texto).not.toContain(QUEJA_PREGUNTA_MARCA);
  });
});

describe("turno de WhatsApp: queja sin detalle -> pregunta, aviso registrado, agente NO callado", () => {
  it("queja simple: texto fijo con la pregunta, un aviso al equipo, sin toma (sin escalacion) y sin llamar al modelo", async () => {
    const { f, provider, handler } = armar();
    const t = await handler.handleInboundMessage(turno(f.organizationId, "Quiero poner una queja"));
    expect(provider.callCount).toBe(0);
    expect(t.reply).toBe(QUEJA_PREGUNTA_DETALLE);
    expect(escalacion(t)).toBeUndefined();
    const a = avisos(f.repo, f.organizationId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ reason: "escalada:queja" });
  });

  it("segundo mensaje con el detalle: se agrega al MISMO aviso, texto fijo de recibido y ahora si cede (escalacion queja)", async () => {
    const { f, provider, handler } = armar();
    await handler.handleInboundMessage(turno(f.organizationId, "Quiero poner una queja"));
    const t = await handler.handleInboundMessage(turno(f.organizationId, "No me mandaron las salsas y la horchata llegó tibia", [{ role: "user", content: "Quiero poner una queja" }, ...preguntaPrevia]));
    expect(provider.callCount).toBe(0);
    expect(t.reply).toBe(QUEJA_DETALLE_RECIBIDO);
    expect(escalacion(t)).toEqual({ motivo: "queja" });
    const a = avisos(f.repo, f.organizationId);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).toMatch(/salsas/);
  });

  it("queja con detalle en el mismo mensaje: cede de inmediato con el texto de siempre, sin repetir la pregunta", async () => {
    const { f, handler } = armar();
    const t = await handler.handleInboundMessage(turno(f.organizationId, "Llegó frío y faltó un agua"));
    expect(t.reply).toContain("no puedo prometerle");
    expect(t.reply).not.toContain(QUEJA_PREGUNTA_MARCA);
    expect(escalacion(t)).toEqual({ motivo: "queja" });
  });

  it("el cliente insiste en dinero: se aclara que NO hay devoluciones de dinero, solo cambio de producto, sin prometerlo", async () => {
    const { f, handler } = armar();
    const t = await handler.handleInboundMessage(turno(f.organizationId, "Faltó mi orden de flautas y quiero mi dinero de vuelta", preguntaPrevia));
    expect(t.reply).toMatch(/no hacemos devoluciones de dinero/);
    expect(t.reply).toMatch(/cambio de producto/);
    expect(t.reply).not.toMatch(/le (?:devolvemos|reembolsamos|regresamos)/i);
    expect(escalacion(t)).toEqual({ motivo: "queja" });
    const t2 = await handler.handleInboundMessage(turno(f.organizationId, "Me faltó la bebida de mi pedido, quiero mi dinero de vuelta"));
    expect(t2.reply).toMatch(/no hacemos devoluciones de dinero/);
  });

  it("queja de salud: escalacion inmediata, texto de salud, sin pregunta de detalle, aun esperando un detalle", async () => {
    const { f, handler } = armar();
    for (const previos of [[], preguntaPrevia]) {
      const t = await handler.handleInboundMessage(turno(f.organizationId, "Me intoxiqué después de comer sus tacos", previos));
      expect(escalacion(t)).toEqual({ motivo: "alergia_salud" });
      expect(t.reply).toMatch(/salud/i);
      expect(t.reply).not.toContain(QUEJA_PREGUNTA_MARCA);
    }
  });

  it("spam de quejas: 1 pregunta, el siguiente mensaje cede y queda un solo aviso abierto", async () => {
    const { f, handler } = armar();
    const t1 = await handler.handleInboundMessage(turno(f.organizationId, "queja"));
    expect(t1.reply).toBe(QUEJA_PREGUNTA_DETALLE);
    const t2 = await handler.handleInboundMessage(turno(f.organizationId, "queja queja queja", [{ role: "user", content: "queja" }, { role: "assistant", content: t1.reply }]));
    expect(escalacion(t2)).toEqual({ motivo: "queja" });
    expect(t2.reply).toBe(QUEJA_DETALLE_RECIBIDO);
    expect(avisos(f.repo, f.organizationId)).toHaveLength(1);
  });

  it("esperando el detalle, «ya no» + un pedido nuevo NO se toma por detalle: sigue el agente", async () => {
    const { f, provider, handler } = armar("Claro, con gusto");
    const t = await handler.handleInboundMessage(turno(f.organizationId, "ya no, gracias. Quiero pedir 3 tacos de pastor", preguntaPrevia));
    expect(provider.callCount).toBeGreaterThan(0);
    expect(escalacion(t)).toBeUndefined();
  });

  it("pedir una persona esperando el detalle manda el motivo cliente_lo_pide", async () => {
    const { f, handler } = armar();
    const t = await handler.handleInboundMessage(turno(f.organizationId, "mejor quiero hablar con una persona", preguntaPrevia));
    expect(escalacion(t)).toEqual({ motivo: "cliente_lo_pide" });
  });
});

describe("integracion con R-21: el agente solo calla cuando llega el detalle", () => {
  it("queja a secas no abre toma; el detalle la abre y desde entonces el agente calla", async () => {
    const { f, provider, handler } = armar("Claro, con gusto");
    const store = new InMemoryConversacionesRepository({ actorUserId: "00000000-0000-4000-8000-0000000000f1" });
    const gate = new InMemoryHandoffAgentGate(store);
    const propertyId = "00000000-0000-4000-8000-0000000000a1";
    store.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: f.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
    const enviar = (messageId: string, body: string) => handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId, phone: PHONE, body, phoneNumberId: "1", propertyId, handoffGate: gate });
    const r1 = await enviar("m1", "Quiero poner una queja");
    expect(r1).toMatchObject({ ok: true, escalated: false });
    expect(r1.reply).toContain(QUEJA_PREGUNTA_MARCA);
    expect(store.handoffs).toHaveLength(0);
    const r2 = await enviar("m2", "Me faltaron los tacos de bistec");
    expect(r2).toMatchObject({ ok: true, escalated: true });
    expect(r2.reply).toContain("registrado");
    expect(store.handoffs).toHaveLength(1);
    const llamadas = provider.callCount;
    const r3 = await enviar("m3", "hola??");
    expect(r3.reply).toBeUndefined();
    expect(provider.callCount).toBe(llamadas);
  });

  it("abreTomaDeHandoff sigue abriendo para queja (la decision de no abrir esta en el turno, no en la regla)", () => {
    expect(abreTomaDeHandoff("queja", [{ role: "user", content: "x" }])).toBe(true);
  });
});
