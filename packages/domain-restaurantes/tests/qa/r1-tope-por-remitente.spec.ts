// QA R1 agentes-12 -- tope por remitente antes del LLM: 40 mensajes seguidos de un mismo telefono ya no son 40 turnos pagados.
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMITENTE_EXCEDIDO_TEXTO, REMITENTE_MAX_TURNOS } from "../../src/whatsapp/inbound.ts";
import { banco, say } from "./r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("agentes-12: tope de turnos por remitente", () => {
  it("40 mensajes seguidos del mismo telefono: solo REMITENTE_MAX_TURNOS llegan al modelo; el primero fuera del tope recibe un aviso fijo y el resto se calla", async () => {
    const b = await banco();
    b.setGuion([say("¿Qué le gustaría pedir?")]);
    const respuestas: Array<string | undefined> = [];
    for (let i = 0; i < 40; i++) respuestas.push((await b.enviar("+5219990000016", `hola ${i}`)).reply);
    expect(b.llamadasLlm()).toBe(REMITENTE_MAX_TURNOS);
    expect(respuestas[REMITENTE_MAX_TURNOS]).toContain(REMITENTE_EXCEDIDO_TEXTO);
    expect(respuestas.slice(REMITENTE_MAX_TURNOS + 1).every((r) => r === undefined)).toBe(true);
  });

  it("el tope es POR remitente: otro telefono no se ve afectado por el spam del primero", async () => {
    const b = await banco();
    b.setGuion([say("¿Qué le gustaría pedir?")]);
    for (let i = 0; i < REMITENTE_MAX_TURNOS + 5; i++) await b.enviar("+5219990000016", `hola ${i}`);
    const antes = b.llamadasLlm();
    const r = await b.enviar("+5219990000040", "hola, quiero pedir");
    expect(b.llamadasLlm()).toBe(antes + 1);
    expect(r.reply).toContain("¿Qué le gustaría pedir?");
  });

  it("el limitador caido (base sin migrar) NO deja sin respuesta al cliente: el turno sigue", async () => {
    const b = await banco();
    b.w.repo.consumeRateLimit = async () => {
      throw new Error("sin tabla de limites");
    };
    b.setGuion([say("Hola, ¿qué le preparamos?")]);
    const r = await b.enviar("+5219990000041", "hola");
    expect(r.reply).toContain("¿qué le preparamos?");
  });
});
