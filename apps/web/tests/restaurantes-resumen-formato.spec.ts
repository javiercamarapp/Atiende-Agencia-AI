import { describe, expect, it } from "vitest";
import { actividadMasReciente, cuandoEnZona, deltaDe, horaEnZona, saludoEnZona } from "../src/verticals/restaurantes/lib/resumen-formato.ts";

describe("resumen-formato (Resumen de restaurantes)", () => {
  it("el saludo usa la hora de la zona de la sucursal", () => {
    const f = new Date("2026-10-02T01:30:00Z");
    expect(horaEnZona(f, "America/Mexico_City")).toBe(19);
    // Misma franja que el backend (saludoPorHora): buenas tardes hasta las 19:59, buenas noches desde las 20:00.
    expect(saludoEnZona(f, "America/Mexico_City")).toBe("Buenas tardes");
    expect(saludoEnZona(new Date("2026-10-02T02:00:00Z"), "America/Mexico_City")).toBe("Buenas noches");
    expect(saludoEnZona(f, "Asia/Tokyo")).toBe("Buenos días");
    expect(saludoEnZona(new Date("2026-10-02T20:00:00Z"), "America/Mexico_City")).toBe("Buenas tardes");
  });

  it("una zona invalida o ausente cae a la del navegador sin lanzar", () => {
    const f = new Date("2026-10-02T12:00:00Z");
    expect(horaEnZona(f, "No/Existe")).toBe(f.getHours());
    expect(horaEnZona(f, null)).toBe(f.getHours());
  });

  it("deltaDe: sin base es null (nunca 0 %); con base conserva el signo y redondea a un decimal", () => {
    expect(deltaDe(null)).toBeNull();
    expect(deltaDe(undefined)).toBeNull();
    expect(deltaDe(Number.NaN)).toBeNull();
    expect(deltaDe(12.44)).toEqual({ pct: 12.4, bueno: true });
    expect(deltaDe(-2.3)).toEqual({ pct: -2.3, bueno: false });
  });

  it("cuandoEnZona: fecha invalida = null; zona invalida no lanza", () => {
    expect(cuandoEnZona("no-es-fecha", "America/Mexico_City")).toBeNull();
    expect(cuandoEnZona("2026-10-02T20:05:00Z", "America/Mexico_City")).toMatch(/2 oct/);
    expect(cuandoEnZona("2026-10-02T20:05:00Z", "No/Existe")).not.toBeNull();
  });

  it("actividadMasReciente no asume el orden y ignora fechas invalidas", () => {
    expect(actividadMasReciente([])).toBeNull();
    expect(actividadMasReciente([{ actividadEn: "x" }])).toBeNull();
    expect(actividadMasReciente([{ actividadEn: "2026-10-01T10:00:00Z" }, { actividadEn: "2026-10-02T10:00:00Z" }, { actividadEn: "2026-09-30T10:00:00Z" }])).toBe("2026-10-02T10:00:00Z");
  });
});
