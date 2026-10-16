// Interaccion #558 (pesos coloquiales) x #555 (limpieza de puntuacion en «sin X»): la limpieza de puntuacion borraba la coma ANTES de que el parser de peso la viera,
// y «un kilo, 250 de pastor» llegaba como «un kilo 250 de pastor» (1250 g). Ambos comportamientos deben convivir en la misma frase.
import { describe, expect, it } from "vitest";
import { tokenizeForProductSearch } from "../src/product-search.ts";

describe("la coma entre cantidades de peso sigue separandolas aunque se limpie la puntuacion de «sin X»", () => {
  it("«2 nachos sin pastor, un kilo, 250 de bistec»: la resta y el kilo sobreviven, y 250 NO se suma al kilo", () => {
    const t = tokenizeForProductSearch("2 nachos sin pastor, un kilo, 250 de bistec");
    expect(t).toContain("sin");
    expect(t).toContain("pastor");
    expect(t).toContain("peso:1000");
    expect(t).not.toContain("peso:1250");
  });
  it("«nachos sin pastor. un kilo, 250 de bistec» (punto + coma)", () => {
    const t = tokenizeForProductSearch("nachos sin pastor. un kilo, 250 de bistec");
    expect(t).toEqual(expect.arrayContaining(["sin", "pastor", "peso:1000"]));
    expect(t).not.toContain("peso:1250");
  });
  it("«nachos sin pastor, por favor», «s/pastor» y «sin pastor.» siguen dando la misma resta limpia", () => {
    expect(tokenizeForProductSearch("nachos sin pastor, por favor")).toEqual(["nacho", "sin", "pastor"]);
    expect(tokenizeForProductSearch("nachos s/pastor")).toEqual(["nacho", "sin", "pastor"]);
    expect(tokenizeForProductSearch("nachos sin pastor.")).toEqual(["nacho", "sin", "pastor"]);
  });
  it("sin coma, «kilo 250 de pastor» y el decimal «1,25 kg» siguen siendo 1250 g", () => {
    expect(tokenizeForProductSearch("kilo 250 de pastor")).toContain("peso:1250");
    expect(tokenizeForProductSearch("1,25 kg de pastor")).toContain("peso:1250");
  });
});
