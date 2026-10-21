// PM Ronda 16 (G7-8-10): tras escalar, cada mensaje del cliente con la toma PENDIENTE recibe una respuesta breve y honesta, aunque llegue segundos despues
// (antes la base solo daba UN acuse pasado 1 min y cada 15 min -> "(sin respuesta nueva)"). Con la toma TOMADA atiende la persona. Sin llamar al modelo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACUSE_HANDOFF_PENDIENTE } from "../src/whatsapp/inbound.ts";
import { MARTES_14H, nuevoViaje, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

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

  it("cada mensaje posterior recibe respuesta (no solo uno cada 15 min), sin llamar al modelo ni reabrir la venta", async () => {
    const v = await escalado();
    const llamadas = v.requests.length;
    for (const t of ["hola?", "¿ya salió?", "???"]) {
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
