import { describe, expect, it } from "vitest";
import { computeQuote, parseQuoteInput, nightsBetween, QuoteError, QuoteInputValidationError } from "../src/quote.ts";

const BASE_RATES = [
  { date: "2026-10-01", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
  { date: "2026-10-02", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
  { date: "2026-10-03", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
];

describe("parseQuoteInput -- guardia anti-alucinación de precio (REQ-REV-001)", () => {
  it("acepta un input válido y construye el objeto interno", () => {
    const input = parseQuoteInput({
      checkInDate: "2026-10-01",
      checkOutDate: "2026-10-03",
      nightlyRates: BASE_RATES,
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
    });
    expect(input.currency).toBe("MXN");
    expect(input.nightlyRates).toHaveLength(3);
  });

  it("un precio inyectado por un canal conversacional (llmSuggestedPrice) es estructuralmente descartado -- nunca llega al output", () => {
    const malicious = {
      checkInDate: "2026-10-01",
      checkOutDate: "2026-10-02",
      llmSuggestedPrice: 1, // intento de alucinar un precio de $1
      nightlyRates: [{ ...BASE_RATES[0], llmSuggestedPrice: 1, price: 1000 }],
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
    };
    const input = parseQuoteInput(malicious);
    // El campo extra nunca aparece en el objeto parseado.
    expect(Object.prototype.hasOwnProperty.call(input, "llmSuggestedPrice")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input.nightlyRates[0], "llmSuggestedPrice")).toBe(false);
    // El precio real (de rate_plan) es el único que sobrevive.
    expect(input.nightlyRates[0]!.price).toBe(1000);
    const quote = computeQuote(input);
    expect(quote.nightlyBreakdown[0]!.price).toBe(1000);
  });

  it("rechaza checkOutDate <= checkInDate", () => {
    expect(() =>
      parseQuoteInput({ checkInDate: "2026-10-05", checkOutDate: "2026-10-01", nightlyRates: BASE_RATES, taxConfig: { ivaRate: 0, ishRate: 0 } }),
    ).toThrow(QuoteInputValidationError);
  });

  it("rechaza un formato de fecha inválido", () => {
    expect(() =>
      parseQuoteInput({ checkInDate: "01-10-2026", checkOutDate: "2026-10-03", nightlyRates: BASE_RATES, taxConfig: { ivaRate: 0, ishRate: 0 } }),
    ).toThrow(QuoteInputValidationError);
  });
});

describe("computeQuote", () => {
  it("cotiza 2 noches con impuestos aplicados sobre el subtotal", () => {
    const quote = computeQuote({
      checkInDate: "2026-10-01",
      checkOutDate: "2026-10-03",
      currency: "MXN",
      nightlyRates: BASE_RATES,
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
    });
    expect(quote.nights).toBe(2);
    expect(quote.netAmount).toBe(2000);
    expect(quote.totalAmount).toBe(2000 * 1.19);
  });

  it("sin tarifa configurada para la fecha de llegada -> sin_tarifa", () => {
    expect(() =>
      computeQuote({ checkInDate: "2026-11-01", checkOutDate: "2026-11-02", currency: "MXN", nightlyRates: BASE_RATES, taxConfig: { ivaRate: 0, ishRate: 0 } }),
    ).toThrow(QuoteError);
  });

  it("cerrado a llegada (CTA) bloquea la cotización", () => {
    const rates = [{ ...BASE_RATES[0]!, closedToArrival: true }, BASE_RATES[1]!];
    expect(() => computeQuote({ checkInDate: "2026-10-01", checkOutDate: "2026-10-02", currency: "MXN", nightlyRates: rates, taxConfig: { ivaRate: 0, ishRate: 0 } })).toThrowError(
      /cerrado a llegadas/,
    );
  });

  it("estadía mínima no alcanzada", () => {
    const rates = [{ ...BASE_RATES[0]!, minStay: 3 }, BASE_RATES[1]!];
    try {
      computeQuote({ checkInDate: "2026-10-01", checkOutDate: "2026-10-02", currency: "MXN", nightlyRates: rates, taxConfig: { ivaRate: 0, ishRate: 0 } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteError);
      expect((err as InstanceType<typeof QuoteError>).code).toBe("estadia_minima_no_alcanzada");
    }
  });
});

describe("nightsBetween", () => {
  it("calcula las noches [checkIn, checkOut)", () => {
    expect(nightsBetween("2026-10-01", "2026-10-04")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
});
