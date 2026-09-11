import { describe, expect, it } from "vitest";
import { applyTaxes, assertValidTaxConfig } from "../src/taxes.ts";
import { roundCurrency } from "../src/money.ts";

describe("applyTaxes", () => {
  it("calcula IVA e ISH sobre el neto redondeado", () => {
    const result = applyTaxes(1000, { ivaRate: 0.16, ishRate: 0.03 });
    expect(result).toEqual({ netAmount: 1000, ivaAmount: 160, ishAmount: 30, totalAmount: 1190 });
  });

  it("rechaza tasas negativas", () => {
    expect(() => assertValidTaxConfig({ ivaRate: -0.1, ishRate: 0 })).toThrow(RangeError);
    expect(() => applyTaxes(100, { ivaRate: 0, ishRate: -0.01 })).toThrow(RangeError);
  });
});

describe("roundCurrency", () => {
  it("redondea a 2 decimales de forma consistente", () => {
    expect(roundCurrency(10.005)).toBe(10.01);
    expect(roundCurrency(10.004)).toBe(10);
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
  });
});
