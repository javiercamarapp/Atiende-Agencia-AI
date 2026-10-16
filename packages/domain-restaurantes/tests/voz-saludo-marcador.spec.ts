import { describe, expect, it } from "vitest";
import { resolverMarcadorSaludo } from "../src/voz/saludo-marcador.ts";

// 2026-10-04T15:00Z = 09:00 en Merida (UTC-6, sin horario de verano), 15:00 UTC, 03:00 en Tokio del dia siguiente.
const BASE = new Date("2026-10-04T15:00:00.000Z");
const en = (horasUtc: number) => new Date(BASE.getTime() + (horasUtc - 15) * 3_600_000);

describe("marcador {saludo} del mensaje inicial de voz", () => {
  it("se resuelve con la HORA LOCAL de la sucursal, no la del proceso (UTC)", () => {
    expect(resolverMarcadorSaludo("{saludo}, le atiende Los Taquitos de PM.", "America/Merida", BASE)).toBe("Buenos días, le atiende Los Taquitos de PM.");
    // 20:00 UTC = 14:00 en Merida => tardes; 02:00 UTC = 20:00 en Merida => noches (aunque en UTC sea madrugada).
    expect(resolverMarcadorSaludo("Le deseamos {saludo}", "America/Merida", en(20))).toBe("Le deseamos buenas tardes");
    expect(resolverMarcadorSaludo("Le deseamos {saludo}", "America/Merida", en(26))).toBe("Le deseamos buenas noches");
  });

  it("la misma instante da saludos distintos en zonas distintas", () => {
    expect(resolverMarcadorSaludo("Hola, {saludo}", "America/Merida", BASE)).toBe("Hola, buenos días");
    expect(resolverMarcadorSaludo("Hola, {saludo}", "Asia/Tokyo", BASE)).toBe("Hola, buenas noches");
  });

  it("capitaliza solo al inicio de frase y reemplaza todas las apariciones; un texto sin marcador queda igual", () => {
    expect(resolverMarcadorSaludo("Hola. {saludo}, bienvenido; que tenga {saludo}.", "America/Merida", BASE)).toBe("Hola. Buenos días, bienvenido; que tenga buenos días.");
    expect(resolverMarcadorSaludo("Hola, le atiende el asistente.", "America/Merida", BASE)).toBe("Hola, le atiende el asistente.");
  });

  it("la medianoche local no revienta (hour12 false puede dar 24)", () => {
    expect(resolverMarcadorSaludo("Hola, {saludo}", "America/Merida", en(6))).toBe("Hola, buenas noches");
  });
});
