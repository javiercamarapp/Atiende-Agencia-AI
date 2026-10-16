// QA-PM-R3-voz-05 (P3): "que me comunique con alguien de caja" escalaba en falso (cliente_lo_pide) tras un pedido para recoger: el pago es en caja al recoger.
import { describe, expect, it } from "vitest";
import { pideUnaPersona } from "../src/whatsapp/guards.ts";
import { evaluarPersonaVoz } from "../src/voz/guardia-persona.ts";

describe("'alguien de caja' no pide una persona", () => {
  it.each(["que me atienda alguien en caja", "que me comunique con alguien de caja", "me pasa con alguien en la caja por favor"])("%s", (t) => {
    expect(pideUnaPersona(t)).toBe(false);
  });
  it.each(["quiero hablar con alguien", "que me atienda una persona", "comuníqueme con el gerente", "pásame con alguien de caja y con el gerente, quiero hablar con una persona"])("%s sigue pidiendo una persona", (t) => {
    expect(pideUnaPersona(t)).toBe(true);
  });
  it("la guardia de voz tampoco escala", () => {
    expect(evaluarPersonaVoz("que me atienda alguien en caja")).toBeNull();
  });
});
