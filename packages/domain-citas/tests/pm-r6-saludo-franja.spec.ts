// QA-PM-R6: el saludo del agente de citas usa el mismo corte que restaurantes (buenas tardes hasta las 19:59, buenas noches desde las 20:00). Zona explicita, sin TZ de proceso.
import { describe, expect, it } from "vitest";
import { saludoSegunHora } from "../src/whatsapp/llm-turn-handler.ts";

describe("saludoSegunHora (citas)", () => {
  it.each([
    ["04:59", "Buenas noches"], ["05:00", "Buenos días"], ["11:59", "Buenos días"], ["12:00", "Buenas tardes"], ["19:00", "Buenas tardes"], ["19:59", "Buenas tardes"], ["20:00", "Buenas noches"],
  ])("a las %s en Mérida", (hhmm, esperado) => {
    expect(saludoSegunHora("America/Merida", new Date(`2026-10-06T${hhmm}:00-06:00`))).toBe(esperado);
  });
});
