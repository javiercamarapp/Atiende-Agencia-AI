// Interruptor de emergencia unificado (migracion 103), lado WhatsApp: apagado por sucursal o por organizacion NO llama al modelo, responde el texto fijo UNA vez
// y abre un handoff para una persona; las demas sucursales siguen; encendido de nuevo vuelve a atender; una lectura que falla NO deja al cliente sin agente.
// El lado de voz esta en apps/api/tests/restaurantes-interruptor-emergencia.spec.ts (misma fuente de verdad).
import { describe, expect, it } from "vitest";
import { AGENTE_APAGADO_TEXTO, MOTIVO_AGENTE_APAGADO, handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { InMemoryConversacionesRepository, InMemoryHandoffAgentGate, InMemoryInterruptorEmergencia, agenteDebeAtender } from "../src/index.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219991234567";
const STAFF = "00000000-0000-4000-8000-0000000000f1";
const OTRA_SUCURSAL = "00000000-0000-4000-8000-0000000000e2";

function setup() {
  const fixture = buildRestaurantFixture();
  const store = new InMemoryConversacionesRepository({ actorUserId: STAFF });
  const gate = new InMemoryHandoffAgentGate(store);
  const interruptor = new InMemoryInterruptorEmergencia();
  let turnos = 0;
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos += 1;
      return { reply: "Respuesta del agente", orderId: null, propertyId: null };
    },
  };
  store.conversaciones.push({ canal: "whatsapp", id: "00000000-0000-4000-8000-0000000000c1", organizationId: fixture.organizationId, propertyId: fixture.propertyId, telefono: PHONE, mensajes: [], actividadAt: new Date().toISOString() });
  const enviar = (messageId: string, opciones: { propertyId?: string | null; sinInterruptor?: boolean } = {}) =>
    handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      messageId,
      phone: PHONE,
      body: "Quiero un pedido",
      phoneNumberId: "1",
      propertyId: opciones.propertyId === undefined ? fixture.propertyId : opciones.propertyId,
      handoffGate: gate,
      ...(opciones.sinInterruptor ? {} : { interruptor }),
    });
  return { fixture, store, interruptor, enviar, turnos: () => turnos };
}

describe("interruptor de emergencia: WhatsApp", () => {
  it("sin interruptor accionado el agente atiende como siempre", async () => {
    const t = setup();
    expect(await t.enviar("m1")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("apagado por SUCURSAL: sin modelo, texto fijo una vez y un handoff para una persona", async () => {
    const t = setup();
    t.interruptor.fijar(t.fixture.organizationId, t.fixture.propertyId, true, STAFF, "emergencia");
    expect(await t.enviar("m2")).toMatchObject({ ok: true, reply: AGENTE_APAGADO_TEXTO, escalated: true });
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
    expect(t.store.handoffs[0]).toMatchObject({ estado: "pendiente", motivo: MOTIVO_AGENTE_APAGADO });
    expect(await t.enviar("m3")).toEqual({ ok: true, retryable: false }); // la toma abierta calla; no se repite el texto
    expect(t.turnos()).toBe(0);
    expect(t.store.handoffs).toHaveLength(1);
  });

  it("apagado de TODA la organizacion apaga cualquier sucursal, incluso un mensaje sin sucursal resuelta", async () => {
    const t = setup();
    t.interruptor.fijar(t.fixture.organizationId, null, true, STAFF);
    expect(await t.enviar("m4")).toMatchObject({ reply: AGENTE_APAGADO_TEXTO });
    expect(t.turnos()).toBe(0);
  });

  it("apagar una sucursal NO apaga otra", async () => {
    const t = setup();
    t.interruptor.fijar(t.fixture.organizationId, OTRA_SUCURSAL, true, STAFF);
    expect(await t.enviar("m5")).toMatchObject({ reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
  });

  it("volver a encenderlo devuelve la atencion al agente", async () => {
    const t = setup();
    t.interruptor.fijar(t.fixture.organizationId, t.fixture.propertyId, true, STAFF);
    await t.enviar("m6");
    t.interruptor.fijar(t.fixture.organizationId, t.fixture.propertyId, false, STAFF);
    const id = t.store.handoffs[0]!.id;
    await t.store.tomar(t.fixture.organizationId, t.fixture.propertyId, "whatsapp", "00000000-0000-4000-8000-0000000000c1");
    await t.store.devolver(t.fixture.organizationId, t.fixture.propertyId, id);
    expect(await t.enviar("m7")).toMatchObject({ reply: "Respuesta del agente" });
  });

  it("si la lectura del interruptor falla, el cliente NO se queda sin agente (falla abierto)", async () => {
    const t = setup();
    t.interruptor.fijar(t.fixture.organizationId, t.fixture.propertyId, true, STAFF);
    t.interruptor.fallaLectura = true;
    expect(await t.enviar("m8")).toMatchObject({ reply: "Respuesta del agente" });
  });

  it("agenteDebeAtender: el control propio Y el interruptor deben permitirlo", () => {
    expect(agenteDebeAtender(true, false)).toBe(true);
    expect(agenteDebeAtender(true, true)).toBe(false);
    expect(agenteDebeAtender(false, false)).toBe(false);
  });
});
