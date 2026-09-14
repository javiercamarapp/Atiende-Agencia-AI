import { describe, expect, it } from "vitest";
import { addBusinessDays, daysBetween, CALENDAR_LIMITATION_NOTE } from "../src/business-days.ts";

describe("business-days.ts -- motor determinista de días hábiles", () => {
  it("suma días hábiles saltando sábado/domingo", () => {
    // 2026-01-05 es lunes.
    expect(addBusinessDays("2026-01-05", 1)).toBe("2026-01-06");
    // 5 días hábiles desde un lunes cae el lunes siguiente (salta el fin de semana).
    expect(addBusinessDays("2026-01-05", 5)).toBe("2026-01-12");
  });

  it("0 días hábiles devuelve la misma fecha", () => {
    expect(addBusinessDays("2026-01-05", 0)).toBe("2026-01-05");
  });

  it("excluye feriados declarados explícitamente además de sábado/domingo", () => {
    // 2026-01-05 lunes -> +1 día hábil sin feriados = martes 06.
    // Con el martes 06 declarado feriado, el siguiente día hábil es miércoles 07.
    expect(addBusinessDays("2026-01-05", 1, ["2026-01-06"])).toBe("2026-01-07");
  });

  it("rechaza businessDays negativo o no entero (fail-closed)", () => {
    expect(() => addBusinessDays("2026-01-05", -1)).toThrow();
    expect(() => addBusinessDays("2026-01-05", 1.5)).toThrow();
  });

  it("rechaza una fecha de inicio inválida", () => {
    expect(() => addBusinessDays("no-es-una-fecha", 1)).toThrow();
  });

  it("daysBetween calcula días de calendario (puede ser negativo)", () => {
    expect(daysBetween("2026-01-01", "2026-01-10")).toBe(9);
    expect(daysBetween("2026-01-10", "2026-01-01")).toBe(-9);
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("documenta honestamente la limitación del calendario (sin feriados oficiales codificados)", () => {
    expect(CALENDAR_LIMITATION_NOTE).toMatch(/sábados y domingos/);
    expect(CALENDAR_LIMITATION_NOTE).toMatch(/REQ-056/);
  });
});
