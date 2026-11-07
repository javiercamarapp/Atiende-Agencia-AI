// D-P3-34 (brief paridad3-despachos-fiscal-correcciones): el plazo de resolucion de la devolucion de IVA (art. 22 CFF) usa el calendario
// fiscal del AÑO REAL (feriadosDelAnio: lunes festivos moviles + Jueves/Viernes Santo), no los dias inhabiles de 2026 aplicados a cualquier año.
// Los valores esperados se calcularon con un conteo independiente (script aparte, no la implementacion).
import { describe, expect, it } from "vitest";
import { MEXICO_HOLIDAYS_2026, calcularFechaLimiteResolucion, sumarDiasHabiles } from "../src/devolucion-iva/calculo.ts";

describe("plazo de devolucion de IVA con Semana Santa y festivos del año real", () => {
  it("2025: 20 dias habiles desde 2025-03-31 cruzan Jueves y Viernes Santo (17 y 18 de abril) -> 2025-04-30 (con el calendario 2026 daba 2025-04-28)", () => {
    expect(calcularFechaLimiteResolucion("2025-03-31", true)).toBe("2025-04-30");
    expect(calcularFechaLimiteResolucion("2025-03-31", true, MEXICO_HOLIDAYS_2026)).toBe("2025-04-28");
  });

  it("2025: 40 dias habiles desde 2025-02-28 -> 2025-04-30", () => {
    expect(calcularFechaLimiteResolucion("2025-02-28", false)).toBe("2025-04-30");
  });

  it("2026: Jueves y Viernes Santo son el 2 y 3 de abril -> 20 dias desde 2026-03-30 llegan al 2026-04-29", () => {
    expect(calcularFechaLimiteResolucion("2026-03-30", true)).toBe("2026-04-29");
  });

  it("2026: 40 dias habiles desde 2026-02-27 -> 2026-04-29", () => {
    expect(calcularFechaLimiteResolucion("2026-02-27", false)).toBe("2026-04-29");
  });

  it("2027: Semana Santa temprana (25 y 26 de marzo) y el lunes festivo de marzo es el 15 -> 20 dias desde 2027-03-15 llegan al 2027-04-14", () => {
    expect(calcularFechaLimiteResolucion("2027-03-15", true)).toBe("2027-04-14");
    expect(calcularFechaLimiteResolucion("2027-03-15", true, MEXICO_HOLIDAYS_2026)).toBe("2027-04-13");
  });

  it("los lunes festivos se mueven con el año: el 3er lunes de noviembre es el 17 en 2025 y el 15 en 2027 (no el 16 de 2026)", () => {
    expect(sumarDiasHabiles("2025-11-14", 1)).toBe("2025-11-18"); // lunes 17 festivo
    expect(sumarDiasHabiles("2025-11-14", 1, MEXICO_HOLIDAYS_2026)).toBe("2025-11-17"); // el calendario fijo de 2026 lo contaba habil
    expect(sumarDiasHabiles("2027-11-12", 1)).toBe("2027-11-16"); // lunes 15 festivo
    expect(sumarDiasHabiles("2026-11-13", 1)).toBe("2026-11-17"); // lunes 16 festivo
  });

  it("pasar un conjunto explicito de feriados conserva el comportamiento anterior (compatibilidad)", () => {
    expect(sumarDiasHabiles("2026-04-30", 1, new Set(["5-1"]))).toBe("2026-05-04");
  });
});
