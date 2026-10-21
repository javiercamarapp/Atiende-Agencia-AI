// PM Ronda 16 (G7-8-10): tras escalar, cada mensaje del cliente con la toma PENDIENTE recibe una respuesta breve y honesta, aunque llegue segundos despues
// (antes la base solo daba UN acuse pasado 1 min y cada 15 min -> "(sin respuesta nueva)"). Con la toma TOMADA atiende la persona. Sin llamar al modelo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACUSE_HANDOFF_PENDIENTE, ACUSE_HANDOFF_REPETIDO, ACUSE_QUEJA_EN_TOMA, recibirMensajeConEspera, responderTrasEspera, textoParaTomaPendiente } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { TEL_CLIENTE, MARTES_14H, nuevoViaje, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const avanza = (seg: number): void => {
  vi.setSystemTime(new Date(Date.now() + seg * 1000));
};

async function escalado(): Promise<Viaje> {
  const v = await nuevoViaje();
  expect((await v.escribe("quiero hablar con una persona")).escalated).toBe(true);
  return v;
}

describe("R16: sin silencio tras escalar (toma pendiente)", () => {
  it("un mensaje a los pocos segundos (sin esperar 1 min) recibe respuesta, no silencio", async () => {
    const v = await escalado();
    const r = await v.escribe("¿Ya salió mi pedido?");
    expect(r.reply).toBeTruthy();
    expect(r.reply).not.toMatch(/sin respuesta/i);
    expect(r.escalated).toBe(false);
  });

  it("cada mensaje posterior (separado por mas de 1 min) recibe respuesta, no solo uno cada 15 min, sin llamar al modelo ni reabrir la venta", async () => {
    const v = await escalado();
    const llamadas = v.requests.length;
    for (const t of ["hola?", "¿ya salió?", "???"]) {
      avanza(61); // tope: 1 recordatorio por minuto
      const r = await v.escribe(t);
      expect(r.reply, t).toBeTruthy();
      expect(r.reply, t).not.toMatch(/\$|total|pedido nuevo|reposici[oó]n garantizada/i);
    }
    expect(v.requests.length).toBe(llamadas);
    expect(v.conversaciones.handoffs).toHaveLength(1);
  });

  it("una queja con detalle durante la toma recibe disculpa y texto fijo sin preguntar ni pedir direccion/pin, sin prometer reposicion", async () => {
    const v = await escalado();
    const r = await v.escribe("Recibí el pedido pero no mandaron el guacamole");
    expect(r.reply).toMatch(/lamento|disculp/i);
    expect(r.reply).not.toMatch(/\?|direcci[oó]n|ubicaci[oó]n|\bpin\b/i);
    expect(r.reply).toMatch(/no puedo prometer/i);
    expect(r.reply).toMatch(/equipo|gerente/i);
  });

  it("el primer acuse (tras 1 min) sigue siendo el texto acordado", async () => {
    const v = await escalado();
    vi.setSystemTime(new Date(Date.parse(MARTES_14H) + 2 * 60_000));
    expect((await v.escribe("hola?")).reply).toBe(ACUSE_HANDOFF_PENDIENTE);
  });

  it("con la toma TOMADA por una persona el bot sigue callado", async () => {
    const v = await escalado();
    await v.conversaciones.tomar(v.world.organizationId, v.t7, "whatsapp", v.conversaciones.handoffs[0]!.conversationId);
    expect((await v.escribe("hola?")).reply).toBeUndefined();
  });
});

describe("R16: topes, limites y casos sin toma", () => {
  it("tope: maximo 1 recordatorio por minuto por conversacion; pasado el minuto vuelve a contestar", async () => {
    const v = await escalado();
    expect((await v.escribe("hola?")).reply).toBe(ACUSE_HANDOFF_REPETIDO);
    expect((await v.escribe("???")).reply).toBeUndefined();
    expect((await v.escribe("???!")).reply).toBeUndefined();
    avanza(61); // ya pasó el minuto de espera de la base: sale el acuse oficial
    expect((await v.escribe("hola")).reply).toBe(ACUSE_HANDOFF_PENDIENTE);
    expect((await v.escribe("hola otra vez")).reply).toBeUndefined(); // dentro del minuto
    avanza(61);
    expect((await v.escribe("hola")).reply).toBe(ACUSE_HANDOFF_REPETIDO);
  });

  it("queja SIN toma previa: sigue el camino normal (escala con el texto de siempre), no el texto de toma pendiente", async () => {
    const v = await nuevoViaje();
    const r = await v.escribe("Mi pedido llegó incompleto");
    expect(r.escalated).toBe(true);
    expect(r.reply).toBeTruthy();
    expect(r.reply).not.toBe(ACUSE_QUEJA_EN_TOMA);
    expect(r.reply).not.toBe(ACUSE_HANDOFF_REPETIDO);
  });

  it("ráfaga (responderTrasEspera): con la toma pendiente tambien contesta, sin llamar al modelo", async () => {
    const v = await escalado();
    avanza(61);
    const handler: WhatsAppTurnHandler = { async handleInboundMessage() { throw new Error("el modelo no debe llamarse con la toma abierta"); } };
    const args = { organizationId: v.world.organizationId, messageId: "rafaga-1", phone: TEL_CLIENTE, body: "hola?" };
    expect((await recibirMensajeConEspera(v.world.repo, args)).estado).toBe("responder");
    const out = await responderTrasEspera(v.world.repo, handler, { organizationId: args.organizationId, messageId: "rafaga-1", phone: TEL_CLIENTE, phoneNumberId: "qa-pn-t7", propertyId: v.t7, handoffGate: v.gate });
    expect(out).toMatchObject({ ok: true, reply: ACUSE_HANDOFF_PENDIENTE });
  });

  it("falso positivo: un 'no llegó' a secas NO se trata como queja con detalle (recordatorio breve)", () => {
    for (const t of ["¿ya llegó?", "todavía no llegó", "no llegó nadie"]) expect(textoParaTomaPendiente(t, false, ACUSE_HANDOFF_PENDIENTE), t).toBe(ACUSE_HANDOFF_REPETIDO);
    expect(textoParaTomaPendiente("no mandaron el guacamole", false, ACUSE_HANDOFF_PENDIENTE)).toBe(ACUSE_QUEJA_EN_TOMA);
  });

  it("el texto de queja en toma es honesto: no dice que el gerente ya esta avisado ni promete reposicion", () => {
    expect(ACUSE_QUEJA_EN_TOMA).toMatch(/anotado en la conversación que atiende el equipo/);
    expect(ACUSE_QUEJA_EN_TOMA).not.toMatch(/ya está avisado|revisa su caso/);
  });
});
