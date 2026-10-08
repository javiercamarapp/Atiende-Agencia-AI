// QA-PM-R4-whatsapp-05: "a partir de las 12 del dia" solo entre la 1 am y las 12 pm.
import { describe, expect, it } from "vitest";
import { corregirPromesaDeHorarioNocturno } from "../src/whatsapp/guards.ts";

describe("corregirPromesaDeHorarioNocturno", () => {
  const frases = [
    "Ya avisé al gerente. El equipo le responderá a partir de las 12 del día.",
    "El aviso quedó registrado y el equipo le responde a partir de las 12 del día.",
  ];
  it.each(frases)("a las 13:00 se corrige: %s", (f) => {
    const r = corregirPromesaDeHorarioNocturno(f, 13);
    expect(r).not.toMatch(/a partir de las 12/);
    expect(r).toMatch(/en cuanto puedan/);
  });
  it.each([1, 3, 8, 11])("a la hora %i (de madrugada o manana) se conserva", (h) => {
    for (const f of frases) expect(corregirPromesaDeHorarioNocturno(f, h)).toBe(f);
  });
  it("a las 0 (medianoche, el rango empieza a la 1) tambien se corrige y a las 23 igual", () => {
    expect(corregirPromesaDeHorarioNocturno(frases[0]!, 23)).not.toMatch(/a partir de las 12/);
    expect(corregirPromesaDeHorarioNocturno(frases[0]!, 0)).not.toMatch(/a partir de las 12/);
  });
  it("no toca textos sin la frase", () => {
    expect(corregirPromesaDeHorarioNocturno("Su pedido va en preparación.", 14)).toBe("Su pedido va en preparación.");
  });
});
