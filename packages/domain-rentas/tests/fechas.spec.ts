import { describe, expect, it } from "vitest";
import { calcularNoches, diaDeLaSemana, esRangoValido, nochesDelRango, rangoCubreNoche, rangosSeSuperponen } from "../src/fechas.ts";

describe("esRangoValido", () => {
  it("acepta un rango con fin estrictamente posterior a inicio", () => {
    expect(esRangoValido({ inicio: "2026-06-01", fin: "2026-06-05" })).toBe(true);
  });
  it("rechaza un rango vacío (inicio === fin)", () => {
    expect(esRangoValido({ inicio: "2026-06-01", fin: "2026-06-01" })).toBe(false);
  });
  it("rechaza un rango invertido", () => {
    expect(esRangoValido({ inicio: "2026-06-05", fin: "2026-06-01" })).toBe(false);
  });
  it("rechaza una fecha de calendario que no existe (30 de febrero)", () => {
    expect(esRangoValido({ inicio: "2026-02-28", fin: "2026-02-30" })).toBe(false);
  });
  it("rechaza texto con formato inválido", () => {
    expect(esRangoValido({ inicio: "01/06/2026", fin: "2026-06-05" })).toBe(false);
  });
});

describe("calcularNoches", () => {
  it("cuenta noches como diferencia de días de calendario", () => {
    expect(calcularNoches({ inicio: "2026-06-01", fin: "2026-06-05" })).toBe(4);
  });

  it("caso adversarial DST: el cambio de horario de verano en México (abril) no afecta el conteo de noches", () => {
    // 2026-04-05 es el domingo de cambio a horario de verano en México — con
    // aritmética de Date "de pared" (sumar horas) esto podría dar un día de más o
    // de menos; con Date.UTC anclado a medianoche UTC nunca ocurre.
    expect(calcularNoches({ inicio: "2026-04-01", fin: "2026-04-10" })).toBe(9);
  });

  it("lanza si el rango es inválido", () => {
    expect(() => calcularNoches({ inicio: "2026-06-05", fin: "2026-06-01" })).toThrow();
  });
});

describe("nochesDelRango", () => {
  it("lista una fecha por cada noche, excluyendo el día de fin", () => {
    expect(nochesDelRango({ inicio: "2026-06-01", fin: "2026-06-04" })).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("cruza el fin de mes correctamente", () => {
    expect(nochesDelRango({ inicio: "2026-01-30", fin: "2026-02-02" })).toEqual(["2026-01-30", "2026-01-31", "2026-02-01"]);
  });
});

describe("rangoCubreNoche", () => {
  it("incluye el inicio (inclusivo)", () => {
    expect(rangoCubreNoche({ inicio: "2026-06-01", fin: "2026-06-05" }, "2026-06-01")).toBe(true);
  });
  it("excluye el fin (exclusivo)", () => {
    expect(rangoCubreNoche({ inicio: "2026-06-01", fin: "2026-06-05" }, "2026-06-05")).toBe(false);
  });
});

describe("rangosSeSuperponen", () => {
  it("detecta solapamiento real", () => {
    expect(rangosSeSuperponen({ inicio: "2026-06-01", fin: "2026-06-05" }, { inicio: "2026-06-03", fin: "2026-06-07" })).toBe(true);
  });
  it("estancias contiguas (checkout de A = check-in de B) NO son solapamiento (caso adversarial 15)", () => {
    expect(rangosSeSuperponen({ inicio: "2026-06-01", fin: "2026-06-05" }, { inicio: "2026-06-05", fin: "2026-06-08" })).toBe(false);
  });
});

describe("diaDeLaSemana", () => {
  it("2026-06-01 es lunes -> 1 (convención 0=domingo..6=sábado)", () => {
    expect(diaDeLaSemana("2026-06-01")).toBe(1);
  });
  it("2026-06-07 es domingo -> 0", () => {
    expect(diaDeLaSemana("2026-06-07")).toBe(0);
  });
});
