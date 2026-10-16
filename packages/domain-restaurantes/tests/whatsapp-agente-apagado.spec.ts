// Interruptor DURO del agente de WhatsApp por sucursal (053): con el agente apagado NO se llama al modelo (contador del turno en 0), se
// responde UNA vez con un texto fijo y honesto, se abre UN handoff con motivo `agente_apagado` y la conversacion queda en la bandeja.
import { describe, expect, it } from "vitest";
import { AGENTE_APAGADO_TEXTO, MOTIVO_AGENTE_APAGADO, handleInboundWhatsAppMessage, recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
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
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos += 1;
      return { reply: "Respuesta del agente", orderId: null, propertyId: null };
    },
  };
  const propertyId = fixture.propertyId;
  const convId = "00000000-0000-4000-8000-0000000000c1";
  store.conversaciones.push({ canal: "whatsapp", id: convId, organizationId: fixture.organizationId, propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
  const enviar = (messageId: string, body: string, opciones: { sinGate?: boolean; propertyId?: string | null } = {}) =>
    handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      messageId,
      phone: PHONE,
      body,
      phoneNumberId: "1",
      propertyId: opciones.propertyId === undefined ? propertyId : opciones.propertyId,
      ...(opciones.sinGate ? {} : { handoffGate: gate }),
    });
  return { fixture, store, gate, enviar, propertyId, convId, turnos: () => turnos, turnHandler };
}

describe("agente de WhatsApp apagado por sucursal", () => {
  it("encendido por omision (sin fila): el agente responde como siempre", async () => {
    const t = setup();
    expect(await t.enviar("m1", "Hola")).toMatchObject({ ok: true, reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
    expect(t.store.handoffs).toHaveLength(0);
  });

  it("apagado: no llama al modelo, responde el texto fijo UNA vez y abre un solo handoff `agente_apagado`", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, false);
    const primera = await t.enviar("m2", "Quiero un pedido");
    expect(primera).toMatchObject({ ok: true, reply: AGENTE_APAGADO_TEXTO, escalated: true });
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toMatchObject({ estado: "pendiente", solicitadoPor: "agente", motivo: MOTIVO_AGENTE_APAGADO });

    // Mensajes siguientes del cliente: la toma abierta calla al agente, no se repite el texto, no se abre otro handoff y el modelo sigue sin correr.
    const segunda = await t.enviar("m3", "¿Hola?");
    expect(segunda).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
    // La conversacion queda guardada (texto del cliente y el aviso) para quien la atienda desde la bandeja.
    const historial = await t.fixture.repo.appendWhatsAppUserMessageOnce(t.fixture.organizationId, PHONE, { role: "user", content: "probe" });
    expect(historial.map((m) => m.content)).toEqual(["Quiero un pedido", AGENTE_APAGADO_TEXTO, "¿Hola?", "probe"]);
  });

  it("apagar una sucursal no apaga otra: el numero sin sucursal o de otra sucursal sigue atendiendo el agente", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, false);
    expect(await t.enviar("m4", "Hola", { propertyId: null })).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("volver a encenderlo devuelve la atencion al agente (con la toma ya cerrada)", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, false);
    await t.enviar("m5", "Hola");
    const id = t.store.handoffs[0]!.id;
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, true);
    await t.store.tomar(t.fixture.organizationId, t.propertyId, "whatsapp", t.convId);
    await t.store.devolver(t.fixture.organizationId, t.propertyId, id);
    expect(await t.enviar("m6", "Gracias")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("sin handoffGate (toma imposible de abrir) igual avisa UNA sola vez por ventana y nunca llama al modelo", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, false);
    expect(await t.enviar("m7", "Hola", { sinGate: true })).toMatchObject({ ok: true, reply: AGENTE_APAGADO_TEXTO });
    expect(await t.enviar("m8", "Hola?", { sinGate: true })).toEqual({ ok: true, retryable: false });
    expect(t.turnos()).toBe(0);
  });

  it("un fallo no-migracion al leer el interruptor deja el agente ENCENDIDO (nunca un cliente sin respuesta)", async () => {
    const t = setup();
    t.fixture.repo.findAgenteWhatsappActivo = async () => {
      throw Object.assign(new Error("boom"), { code: "XX000" });
    };
    expect(await t.enviar("m9", "Hola")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("con la espera de rafagas (fase A/B) el interruptor tambien corta antes del modelo", async () => {
    const t = setup();
    await t.fixture.repo.fijarAgenteWhatsappActivo(t.fixture.organizationId, t.propertyId, STAFF, false);
    const recepcion = await recibirMensajeConEspera(t.fixture.repo, { organizationId: t.fixture.organizationId, messageId: "r1", phone: PHONE, body: "Hola" });
    expect(recepcion.estado).toBe("responder");
    const out = await responderTrasEspera(t.fixture.repo, t.turnHandler, { organizationId: t.fixture.organizationId, messageId: "r1", phone: PHONE, phoneNumberId: "1", propertyId: t.propertyId, handoffGate: t.gate });
    expect(out).toMatchObject({ ok: true, reply: AGENTE_APAGADO_TEXTO });
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toMatchObject({ motivo: MOTIVO_AGENTE_APAGADO });
  });
});
