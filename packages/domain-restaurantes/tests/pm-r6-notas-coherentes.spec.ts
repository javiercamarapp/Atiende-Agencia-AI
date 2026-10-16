// QA-PM-R6-voz-02: lo que el cliente excluye en las notas libres no aparece a la vez en «Básicas». Corpus etiquetado + contrato de entrada.
import { describe, expect, it } from "vitest";
import { buildComplementNotes, complementosExcluidosEnNotas } from "../src/order-quote.ts";

const BASICAS = ["salsa_roja", "salsa_verde", "cebolla_cilantro", "limones"] as const;
describe("complementosExcluidosEnNotas", () => {
  it.each([
    ["sin cebolla, sin cilantro y bien dorados", ["cebolla_cilantro"]],
    ["Sin cebolla", ["cebolla_cilantro"]],
    ["sin salsa roja por favor", ["salsa_roja"]],
    ["sin limones y sin salsa verde", ["salsa_verde", "limones"]],
    ["sin pico de gallo", ["salsa_mexicana"]],
    ["bien dorados", []],
    ["con cebolla extra", []],
    ["sin picante", []],
    ["sin cilantro en los frijoles", []],
  ] as const)("%s", (t, esperado) => expect(new Set(complementosExcluidosEnNotas(t))).toEqual(new Set(esperado)));
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("entrada %j -> []", (v) => expect(complementosExcluidosEnNotas(v)).toEqual([]));
});

describe("buildComplementNotes con exclusiones en las notas", () => {
  it("la comanda no dice «sin cebolla» y «Básicas: cebolla con cilantro» a la vez", () => {
    const n = buildComplementNotes("sin cebolla, sin cilantro, bien dorados", [], [], [...BASICAS]);
    expect(n).toContain("sin cebolla, sin cilantro");
    expect(n).toMatch(/Básicas: [^.]*\./);
    expect(n.split("Básicas:")[1]).not.toMatch(/cebolla/i);
    expect(n.split("Básicas:")[1]).toMatch(/roja/i);
  });
  it("sin exclusiones en las notas las basicas siguen completas; lo pedido expresamente gana", () => {
    expect(buildComplementNotes("bien dorados", [], [], [...BASICAS])).toMatch(/cebolla/i);
    expect(buildComplementNotes("sin salsa roja", ["salsa_roja" as never], [], [...BASICAS])).toMatch(/roja/i);
  });
  it("camino sin perfil de basicas tambien", () => {
    expect(buildComplementNotes("sin limones", [], []).split("Complementos incluidos:")[1]).not.toMatch(/limones/i);
  });
});
