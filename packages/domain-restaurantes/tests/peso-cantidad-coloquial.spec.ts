// L2b: gramatica coloquial del parser de pesos (peso-cantidad.ts), directo y sin base. Cada fila falla en origin/main (excepto los negativos, que fijan lo que NO debe activarse).
import { describe, expect, it } from "vitest";
import { LARGO_MAX_CONSULTA_PESO, normalizarPesos } from "../src/peso-cantidad.ts";

describe("normalizarPesos: formas coloquiales de decir el peso", () => {
  it.each([
    // diminutivos
    ["kilito y medio de pastor", "peso:1500 de pastor"], ["medio kilito de pastor", "peso:500 de pastor"], ["un kilito de pastor", "peso:1000 de pastor"], ["cuartito de kilo de pastor", "peso:250 de pastor"],
    // "mitad", conectores y sumas sin "y"
    ["kilo y mitad de pastor", "peso:1500 de pastor"], ["un kilo mas medio de pastor", "peso:1500 de pastor"], ["kilo mas cuarto de pastor", "peso:1250 de pastor"],
    ["kilo 250 de pastor", "peso:1250 de pastor"], ["kilo y 250 de pastor", "peso:1250 de pastor"], ["kilo 500 de pastor", "peso:1500 de pastor"], ["2 kilos 750 de pastor", "peso:2750 de pastor"],
    ["1 kg 250 g de pastor", "peso:1250 de pastor"], ["2 kg 500 g de pastor", "peso:2500 de pastor"], ["kilo 3/4 de pastor", "peso:1750 de pastor"], ["kilo 1/2 de pastor", "peso:1500 de pastor"],
    ["kilo cuarto de pastor", "peso:1250 de pastor"], ["un kilo cuarto de pastor", "peso:1250 de pastor"], ["kilo medio de pastor", "peso:1500 de pastor"],
    ["1 kilo con 250 de pastor", "peso:1250 de pastor"], ["kilo ymedio de pastor", "peso:1500 de pastor"],
    // resta
    ["kilo menos cuarto de pastor", "peso:750 de pastor"], ["un kilo menos un cuarto de pastor", "peso:750 de pastor"], ["dos kilos menos cuarto de pastor", "peso:1750 de pastor"],
    // numeros en letra
    ["doscientos cincuenta gramos de pastor", "peso:250 de pastor"], ["mil doscientos cincuenta gramos de pastor", "peso:1250 de pastor"], ["setecientos cincuenta gramos", "peso:750"],
    ["mil quinientos gramos", "peso:1500"], ["dos mil gramos", "peso:2000"], ["mil gramos", "peso:1000"], ["cien gramos", "peso:100"], ["trescientos gramos", "peso:300"],
    ["kilo doscientos cincuenta", "peso:1250"], ["dos kilos doscientos cincuenta", "peso:2250"], ["un kilo trescientos gramos", "peso:1300"], ["treinta y cinco gramos", "peso:35"],
    // par, miles, punto y signos
    ["un par de kilos de pastor", "peso:2000 de pastor"], ["par de kilos", "peso:2000"], ["1,250 g de pastor", "peso:1250 de pastor"], ["1 kg. de pastor", "peso:1000 de pastor"], ["1 kg. y cuarto de pastor", "peso:1250 de pastor"],
    ["¿kilo y cuarto de pastor?", "peso:1250 de pastor"], ["¡un kilo y medio!", "peso:1500"], ["(medio kilo) de pastor", "peso:500 de pastor"],
    // ya funcionaba y no debe romperse
    ["kilo y medio de pastor", "peso:1500 de pastor"], ["1 1/4 kg", "peso:1250"], ["1¼ kg", "peso:1250"], ["2 y medio kilos", "peso:2500"], ["tres cuartos de kilo", "peso:750"], ["cuarto de kilo", "peso:250"],
  ])("%s -> %s", (entrada, esperado) => {
    expect(normalizarPesos(entrada)).toBe(esperado);
  });
});

describe("normalizarPesos: lo APROXIMADO no es un peso exacto (peso:cualquiera = el agente pregunta)", () => {
  it.each([
    ["kilo y poquito de pastor", "peso:cualquiera de pastor"], ["kilo y pico de pastor", "peso:cualquiera de pastor"], ["un kilo y tantito de pastor", "peso:cualquiera de pastor"], ["kilo y un poco", "peso:cualquiera"], ["kilo y algo", "peso:cualquiera"],
    ["casi un kilo de pastor", "peso:cualquiera de pastor".replace("un ", "") === "" ? "" : "peso:cualquiera de pastor"], ["como kilo y medio de pastor", "peso:cualquiera de pastor"], ["mas o menos un kilo de pastor", "peso:cualquiera de pastor"],
    ["aproximadamente 2 kilos de pastor", "peso:cualquiera de pastor"], ["poco mas de un kilo de pastor", "peso:cualquiera de pastor"], ["unos 2 kilos de pastor", "peso:cualquiera de pastor"],
  ])("%s -> %s", (entrada, esperado) => {
    expect(normalizarPesos(entrada)).toBe(esperado);
  });
});

describe("normalizarPesos: revision (contexto, coma, huecos heredados, rendimiento)", () => {
  it.each([
    ["para las 3, kilo y cuarto de pastor", "para las 3 peso:1250 de pastor"], ["a las 3 kilo y cuarto de pastor", "a las 3 peso:1250 de pastor"], ["mesa 3, kilo de pastor", "mesa 3 peso:1000 de pastor"],
    ["en la 5 kilo de pastor", "en la 5 peso:1000 de pastor"], ["somos 4 kilo y medio", "somos 4 peso:1500"], ["mesa de 4 kilo de pastor", "mesa de 4 peso:1000 de pastor"],
    ["un kilo, 250 de bistec", "peso:1000 250 de bistec"], ["pastor un kilo, 500 de bistec", "pastor peso:1000 500 de bistec"], ["un kilo; 250 de bistec", "peso:1000 250 de bistec"],
    ["un kilo y algo de tomar", "peso:1000 y algo de tomar"], ["un kilo y un poco de salsa extra", "peso:1000 y un poco de salsa extra"], ["kilo y un poco mas", "peso:cualquiera"],
    ["mil 250 gramos", "peso:1250"], ["kiloy cuarto", "peso:1250"], ["kilo y quarto", "peso:1250"], ["cuarto y kilo", "peso:cualquiera"], ["1 1/4 de pastor", "peso:cualquiera de pastor"], ["1 1/4 kg", "peso:1250"],
    ["mesa de cien personas", "mesa de cien personas"], ["veinticinco kilos", "peso:25000"], ["a las 3 y media", "a las 3 y media"], ["3 kilo y cuarto", "peso:3250"],
  ])("%s -> %s", (e, esperado) => {
    expect(normalizarPesos(e)).toBe(esperado);
  });
  it("rendimiento: consultas enormes no tardan ni lanzan RangeError (se dejan sin interpretar)", () => {
    const t0 = Date.now();
    for (const base of ["kilo 250 ", "kilo y ", "1 kg y ", "medio kilo y "]) for (const n of [100, 2000, 20000]) expect(() => normalizarPesos(base.repeat(n))).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(normalizarPesos("kilo y cuarto ".repeat(10))).toContain("peso:");
    expect(normalizarPesos("x".repeat(LARGO_MAX_CONSULTA_PESO + 1))).toBe("x".repeat(LARGO_MAX_CONSULTA_PESO + 1));
  });
  it("contrato: lo que no es texto devuelve '' sin lanzar", () => {
    for (const v of [0, null, undefined, false, true, [], {}, 12, () => 1]) expect(normalizarPesos(v as never)).toBe("");
  });
});

describe("normalizarPesos: NEGATIVOS que NO son peso (no deben activarse)", () => {
  it.each([
    "3 de pastor", "tres de pastor", "2 tacos de pastor", "media orden de nachos de pastor", "medio picosito el pastor", "tacos de pastor para 4 personas",
    "500 pesos de pastor", "$500 de pastor", "mil pesos de pastor", "250 pesos de pastor", "100 de pastor", "750 de pastor", "setecientos cincuenta de pastor",
    "dos y medio de pastor", "a las 3 y media tacos de pastor", "a las tres y cuarto tacos de pastor", "en un cuarto de hora tacos de pastor", "en un cuarto de dia",
    "pastor para el cuarto 3", "5 g de pastor", "1 gramo de pastor", "kilometro de pastor", "tacos 250 pesos", "kilometros de pastor",
    "unos tacos de pastor", "como son los tacos de pastor", "casi nunca pido pastor", "mas o menos picante", "poco mas tarde", "son las diez y pico",
  ])("%s", (entrada) => {
    expect(normalizarPesos(entrada)).not.toMatch(/peso:/);
  });

  it("'kilo 250 pesos' o 'kilo 100 tacos': los gramos sueltos NO se suman cuando lo que sigue es dinero o piezas", () => {
    expect(normalizarPesos("un kilo 250 pesos de pastor")).toBe("peso:1000 250 pesos de pastor");
    expect(normalizarPesos("kilo 100 tacos")).toBe("peso:1000 100 tacos");
    expect(normalizarPesos("kilo 3 de pastor")).toBe("peso:1000 3 de pastor");
    expect(normalizarPesos("kilo 255 de pastor")).toBe("peso:1000 255 de pastor");
    expect(normalizarPesos("kilo 1000 de pastor")).toBe("peso:1000 1000 de pastor");
  });

  it("'dos y medio de pastor' no toma el 'medio' como medio kilo, pero 'pastor y medio de arrachera' (otro producto) si", () => {
    expect(normalizarPesos("dos y medio de pastor")).toBe("dos y medio de pastor");
    expect(normalizarPesos("un kilo de pastor y medio de arrachera")).toBe("peso:1000 de pastor y peso:500 de arrachera");
  });

  it("contrato de entrada: vacio, espacios y signos solos no lanzan ni inventan peso", () => {
    for (const t of ["", " ", "   ", "?", "¿?", "!!!", ".", ",", "kg.", "..."]) expect(() => normalizarPesos(t)).not.toThrow();
    expect(normalizarPesos("")).toBe("");
    expect(normalizarPesos("¿?")).toBe("");
    expect(normalizarPesos("0 kg")).not.toMatch(/peso:/);
    expect(normalizarPesos("0 gramos")).not.toMatch(/peso:/);
    expect(normalizarPesos("0 kilos de pastor")).not.toMatch(/peso:/);
    expect(normalizarPesos("0.0 kg")).not.toMatch(/peso:/);
  });

  it("numeros en letra: no cambian lo que no es peso ni rompen las palabras sueltas", () => {
    expect(normalizarPesos("dos tacos")).toBe("dos tacos");
    expect(normalizarPesos("diez kilos")).toBe("peso:10000");
    expect(normalizarPesos("veinte kilos")).toBe("peso:20000");
    expect(normalizarPesos("veintiun kilos")).toBe("peso:21000");
    expect(normalizarPesos("mesa de cien personas")).toBe("mesa de cien personas");
    expect(normalizarPesos("somos veinticinco en la mesa")).toBe("somos veinticinco en la mesa");
  });
});
