import { describe, expect, it } from "vitest";
import { toCents, fromCents, multiplyRateHalfUp, multiplyQuantityHalfUp, sumCents, MAX_QUANTITY } from "../src/money.ts";

describe("money -- aritmética determinista en centavos (REQ-LIC-006)", () => {
  it("toCents/fromCents son inversas exactas", () => {
    expect(toCents("1234.56")).toBe(123456n);
    expect(fromCents(123456n)).toBe("1234.56");
    expect(fromCents(toCents("0.01"))).toBe("0.01");
  });

  it("rechaza una cadena decimal con formato inválido", () => {
    expect(() => toCents("12.345")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });

  it("multiplyRateHalfUp redondea half-up al centavo (16% IVA)", () => {
    // 100.00 * 0.16 = 16.00 exacto
    expect(fromCents(multiplyRateHalfUp(toCents("100.00"), 0.16))).toBe("16.00");
    // Caso borde de redondeo: 0.125 -> sube a 0.13 (half-up), no banker's rounding.
    expect(fromCents(multiplyRateHalfUp(toCents("1.00"), 0.125))).toBe("0.13");
  });

  it("multiplyQuantityHalfUp calcula subtotales con cantidades fraccionarias", () => {
    expect(fromCents(multiplyQuantityHalfUp(toCents("10.00"), 2.5))).toBe("25.00");
  });

  it("rechaza una cantidad que excede MAX_QUANTITY (protección contra error de captura)", () => {
    expect(() => multiplyQuantityHalfUp(toCents("1.00"), MAX_QUANTITY + 1)).toThrow(/excede la cota máxima/);
  });

  it("sumCents acumula una lista de montos", () => {
    expect(sumCents([100n, 200n, 300n])).toBe(600n);
  });
});
