// QA R1 viaje-14: una toma de handoff pendiente que nadie atiende no deja al cliente sin respuesta por horas. El tiempo y la unicidad los decide el gate
// (aqui el de memoria, que reproduce la funcion de la migracion 045); el agente solo manda el acuse fijo y honesto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACUSE_HANDOFF_PENDIENTE } from "../../src/whatsapp/inbound.ts";
import { MARTES_14H, nuevoViaje, type Viaje } from "./arnes-viaje.ts";

const min = (n: number) => n * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

describe("viaje: acuse al cliente mientras la toma sigue pendiente", () => {
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

  it("recien escalada: el agente calla (no repite 'ya avise' a cada mensaje)", async () => {
    const v = await escalado();
    expect((await v.escribe("hola?")).reply).toBeUndefined();
    avanza(min(10));
    expect((await v.escribe("???")).reply).toBeUndefined();
  });

  it("a los 15 min sin que nadie la tome: UN acuse (queda en el historial y en el outbox); los siguientes mensajes callan", async () => {
    const v = await escalado();
    avanza(min(20));
    const r = await v.escribe("¿alguien me atiende?");
    expect(r.reply).toBe(ACUSE_HANDOFF_PENDIENTE);
    expect(r.escalated).toBe(false);
    expect(v.conversaciones.handoffs[0]!.estado).toBe("pendiente");
    const historial = await v.world.repo.whatsappAppendTurn(v.world.organizationId, "+5219995550111", [], null, null, null);
    expect(historial.at(-1)).toEqual({ role: "assistant", content: ACUSE_HANDOFF_PENDIENTE });
    expect((await v.escribe("hola?")).reply).toBeUndefined();
    avanza(min(30));
    expect((await v.escribe("hola??")).reply).toBeUndefined();
  });

  it("pasada la hora de repeticion vuelve a avisar", async () => {
    const v = await escalado();
    avanza(min(20));
    expect((await v.escribe("hola")).reply).toBe(ACUSE_HANDOFF_PENDIENTE);
    avanza(min(61));
    expect((await v.escribe("sigo aqui")).reply).toBe(ACUSE_HANDOFF_PENDIENTE);
  });

  it("el acuse no promete hora ni dice que el agente seguira: es honesto", () => {
    expect(ACUSE_HANDOFF_PENDIENTE).not.toMatch(/\d+\s*(min|hora)/i);
    expect(ACUSE_HANDOFF_PENDIENTE).toMatch(/seguimos esperando/i);
  });

  it("con la toma TOMADA por una persona el agente no manda acuse (atiende la persona)", async () => {
    const v = await escalado();
    await v.conversaciones.tomar(v.world.organizationId, v.t7, "whatsapp", v.conversaciones.handoffs[0]!.conversationId);
    avanza(min(90));
    expect((await v.escribe("hola?")).reply).toBeUndefined();
  });

  it("base sin migrar (el gate no implementa el acuse): el agente sigue callando como antes", async () => {
    const v = await escalado();
    (v.gate as { acusePendiente?: unknown }).acusePendiente = undefined;
    avanza(min(90));
    expect((await v.escribe("hola?")).reply).toBeUndefined();
  });
});
