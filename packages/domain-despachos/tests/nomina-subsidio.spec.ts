// Subsidio al empleo como % de la UMA mensual (decreto DOF 31-dic-2025). Valores por validar con fiscalista.
// Reemplaza la prueba de la tabla escalonada vieja (tope $407.02), que ya no rige.
import { describe, expect, it } from "vitest";
import { calcularSubsidio } from "../src/nomina/subsidio-empleo.ts";
import { VigenciaNoSoportadaError, subsidioVigente, umaVigente } from "../src/nomina/parametros.ts";

describe("subsidio al empleo 2026 (% de la UMA)", () => {
  it("enero usa 15.59 % de la UMA 2025 (3,439.46) = 536.21", () => {
    expect(calcularSubsidio(10000, "2026-01-31")).toBe(536.21);
  });

  it("desde el 1-feb usa 15.02 % de la UMA 2026 (3,566.22) = 535.65", () => {
    expect(calcularSubsidio(10000, "2026-02-01")).toBe(535.65);
    expect(calcularSubsidio(10000, "2026-12-31")).toBe(535.65);
  });

  it("el último día de enero y el primero de febrero cambian de vigencia", () => {
    expect(calcularSubsidio(10000, "2026-01-31")).not.toBe(calcularSubsidio(10000, "2026-02-01"));
    expect(umaVigente("2026-01-31").diaria).toBe(113.14);
    expect(umaVigente("2026-02-01").diaria).toBe(117.31);
  });

  it("en el tope mensual (11,492.66) hay subsidio y un centavo arriba no", () => {
    expect(calcularSubsidio(11492.66, "2026-03-15")).toBe(535.65);
    expect(calcularSubsidio(11492.67, "2026-03-15")).toBe(0);
  });

  it("ingreso cero o negativo no da subsidio", () => {
    expect(calcularSubsidio(0, "2026-03-15")).toBe(0);
    expect(calcularSubsidio(-5, "2026-03-15")).toBe(0);
  });

  it("quincenal prorratea por días del periodo / 30.4 y no es cero (la tabla vieja daba 0)", () => {
    // 535.6464 / 30.4 × 15 = 264.30
    expect(calcularSubsidio(5000, "2026-02-15", { periodicidad: "quincenal" })).toBe(264.3);
    expect(calcularSubsidio(5000, "2026-02-15", { periodicidad: "quincenal", diasPeriodo: 7 })).toBe(123.34);
  });

  it("quincenal respeta el mismo tope mensual", () => {
    expect(calcularSubsidio(11492.67, "2026-02-15", { periodicidad: "quincenal" })).toBe(0);
  });

  it("fuera de la cobertura del motor lanza error explícito en vez de usar la tasa de otro año", () => {
    expect(() => calcularSubsidio(5000, "2025-12-31")).toThrow(VigenciaNoSoportadaError);
    expect(() => calcularSubsidio(5000, "31/01/2026")).toThrow(VigenciaNoSoportadaError);
    expect(() => subsidioVigente("2025-06-01")).toThrow(VigenciaNoSoportadaError);
  });
});
