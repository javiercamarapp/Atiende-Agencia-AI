// QA R1 viaje-06: el historial que ve el modelo tiene tope (la fila de WhatsApp de un cliente frecuente solo crece).
import { describe, expect, it } from "vitest";
import { HISTORIAL_MAX_CARACTERES, HISTORIAL_MAX_MENSAJES, ventanaDeHistorial } from "../../src/whatsapp/llm-turn-handler.ts";
import type { ConversationMessage } from "../../src/repository.ts";

const chat = (n: number, largo = 10): ConversationMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: `${i}`.padEnd(largo, "x") }));

describe("ventanaDeHistorial", () => {
  it("una conversacion corta pasa completa y sin copiarse", () => {
    const m = chat(6);
    expect(ventanaDeHistorial(m)).toBe(m);
  });

  it("600 mensajes viejos se acotan al tope y conservan el ultimo mensaje del cliente", () => {
    const m = chat(601); // termina en 'user' (indice par)
    const v = ventanaDeHistorial(m);
    expect(v.length).toBeLessThanOrEqual(HISTORIAL_MAX_MENSAJES);
    expect(v.at(-1)).toBe(m.at(-1));
  });

  it("la ventana empieza en un mensaje del cliente", () => {
    const m = chat(HISTORIAL_MAX_MENSAJES + 5);
    for (let extra = 0; extra < 3; extra++) {
      const v = ventanaDeHistorial(chat(HISTORIAL_MAX_MENSAJES + 5 + extra));
      expect(v[0]!.role).toBe("user");
    }
    expect(m.length).toBeGreaterThan(HISTORIAL_MAX_MENSAJES);
  });

  it("tambien hay tope de caracteres, pero el ultimo mensaje nunca se pierde aunque solo el exceda el tope", () => {
    const largos = chat(30, 3_000); // 90k caracteres
    const v = ventanaDeHistorial(largos);
    expect(v.reduce((a, x) => a + x.content.length, 0)).toBeLessThanOrEqual(HISTORIAL_MAX_CARACTERES + 3_000);
    expect(v.at(-1)).toBe(largos.at(-1));
    const unico: ConversationMessage[] = [{ role: "user", content: "y".repeat(HISTORIAL_MAX_CARACTERES + 10) }];
    expect(ventanaDeHistorial(unico)).toEqual(unico);
  });
});
