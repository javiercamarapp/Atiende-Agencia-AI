// Revision de #530: saludoPorHora (voice-core) pasa a buenas tardes hasta las 19:59 y buenas noches desde las 20:00; los saludos del panel que dicen
// seguir "la misma regla" (greeting.ts, despachos/saludo.ts, resumen-formato.ts) usan la misma franja. Horas por componentes locales y zona explicita: sin TZ de proceso.
import { describe, expect, it } from "vitest";
import { saludoPorHora } from "../src/lib/greeting.ts";
import { saludoDespacho } from "../src/verticals/despachos/lib/saludo.ts";
import { saludoEnZona } from "../src/verticals/restaurantes/lib/resumen-formato.ts";

// Regla del backend (voice-core saludoPorHora): buenos días 5:00-11:59, buenas tardes 12:00-19:59, buenas noches el resto.
const esperadoDe = (h: number) => (h >= 5 && h < 12 ? "Buenos días" : h >= 12 && h < 20 ? "Buenas tardes" : "Buenas noches");

describe("mismas franjas que el backend", () => {
  it.each([0, 4, 5, 11, 12, 18, 19, 20, 23])("a las %i h", (h) => {
    const esperado = esperadoDe(h);
    expect(saludoPorHora(new Date(2026, 9, 6, h, 30))).toBe(esperado);
    // 2026-10-06 hh:30 en Ciudad de Mexico (UTC-6, sin horario de verano) = hh+6:30 UTC.
    const enMexico = new Date(Date.UTC(2026, 9, 6, h + 6, 30));
    expect(saludoEnZona(enMexico, "America/Mexico_City")).toBe(esperado);
    expect(saludoDespacho(enMexico)).toBe(esperado);
  });
  it("19:30 sigue siendo buenas tardes y 20:00 ya es buenas noches", () => {
    expect(saludoPorHora(new Date(2026, 9, 6, 19, 30))).toBe("Buenas tardes");
    expect(saludoPorHora(new Date(2026, 9, 6, 20, 0))).toBe("Buenas noches");
  });
});
