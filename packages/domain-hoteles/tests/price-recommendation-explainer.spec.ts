import { describe, expect, it } from "vitest";
import {
  PriceExplanationError,
  assertValidPriceRecommendationInput,
  explainPriceRecommendation,
  type PriceRecommendationInput,
} from "../src/revenue/priceRecommendationExplainer.ts";

function baseInput(overrides: Partial<PriceRecommendationInput> = {}): PriceRecommendationInput {
  return {
    hotelId: "hotel-1",
    fecha: "2026-12-24",
    currentPrice: 1000,
    recommendedPrice: 1200,
    currency: "MXN",
    factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 25 }],
    ...overrides,
  };
}

describe("assertValidPriceRecommendationInput", () => {
  it("acepta un input válido con un factor", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput())).not.toThrow();
  });

  it("rechaza hotelId vacío", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ hotelId: "" }))).toThrow(PriceExplanationError);
  });

  it("rechaza fecha con formato inválido", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ fecha: "24-12-2026" }))).toThrow(PriceExplanationError);
  });

  it("rechaza currentPrice <= 0", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ currentPrice: 0 }))).toThrow(PriceExplanationError);
  });

  it("rechaza recommendedPrice negativo", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ recommendedPrice: -1 }))).toThrow(PriceExplanationError);
  });

  it("rechaza moneda vacía", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ currency: "" }))).toThrow(PriceExplanationError);
  });

  it("rechaza cero factores -- nunca inventa una razón genérica", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ factors: [] }))).toThrow(/sin_factores:/);
  });

  it("rechaza dos factores del mismo tipo (contradicción irresoluble)", () => {
    expect(() =>
      assertValidPriceRecommendationInput(
        baseInput({
          factors: [
            { kind: "pickup", onTheBooksVsExpectedPct: 10 },
            { kind: "pickup", onTheBooksVsExpectedPct: -5 },
          ],
        }),
      ),
    ).toThrow(/factor_duplicado:/);
  });

  it("rechaza evento con nombre vacío", () => {
    expect(() =>
      assertValidPriceRecommendationInput(
        baseInput({ factors: [{ kind: "evento", nombre: "", impacto: "alza_demanda", magnitudPct: 10 }] }),
      ),
    ).toThrow(/evento_sin_nombre:/);
  });

  it("rechaza evento con magnitud <= 0", () => {
    expect(() =>
      assertValidPriceRecommendationInput(
        baseInput({ factors: [{ kind: "evento", nombre: "Festival", impacto: "alza_demanda", magnitudPct: 0 }] }),
      ),
    ).toThrow(/evento_magnitud_invalida:/);
  });

  it("rechaza tipo_cambio sin moneda", () => {
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "tipo_cambio", moneda: "", variacionPct: 5 }] })),
    ).toThrow(/tipo_cambio_sin_moneda:/);
  });
});

describe("explainPriceRecommendation", () => {
  it("calcula la dirección 'sube' y el deltaPct correcto", () => {
    const result = explainPriceRecommendation(baseInput({ currentPrice: 1000, recommendedPrice: 1200 }));
    expect(result.direction).toBe("sube");
    expect(result.deltaPct).toBeCloseTo(20);
    expect(result.headline).toContain("sube 20%");
  });

  it("calcula la dirección 'baja'", () => {
    const result = explainPriceRecommendation(baseInput({ currentPrice: 1000, recommendedPrice: 800 }));
    expect(result.direction).toBe("baja");
    expect(result.headline).toContain("baja 20%");
  });

  it("'sin_cambio' cuando el precio prácticamente no cambia (dentro del épsilon)", () => {
    const result = explainPriceRecommendation(baseInput({ currentPrice: 1000, recommendedPrice: 1000 }));
    expect(result.direction).toBe("sin_cambio");
    expect(result.headline).toContain("se mantiene sin cambio");
  });

  it("ordena los factores de mayor a menor magnitud", () => {
    const result = explainPriceRecommendation(
      baseInput({
        factors: [
          { kind: "pickup", onTheBooksVsExpectedPct: 5 },
          { kind: "tipo_cambio", moneda: "USD", variacionPct: 30 },
          { kind: "evento", nombre: "Congreso médico", impacto: "alza_demanda", magnitudPct: 15 },
        ],
      }),
    );
    expect(result.factors.map((f) => f.kind)).toEqual(["tipo_cambio", "evento", "pickup"]);
  });

  it("mantiene el orden de entrada como desempate estable ante magnitudes iguales", () => {
    const result = explainPriceRecommendation(
      baseInput({
        factors: [
          { kind: "pickup", onTheBooksVsExpectedPct: 10 },
          { kind: "tipo_cambio", moneda: "USD", variacionPct: -10 },
        ],
      }),
    );
    expect(result.factors.map((f) => f.kind)).toEqual(["pickup", "tipo_cambio"]);
  });

  it("es determinista: la misma entrada siempre produce la misma salida", () => {
    const input = baseInput();
    expect(explainPriceRecommendation(input)).toEqual(explainPriceRecommendation(input));
  });

  it("fullText concatena headline + cada texto de factor en un párrafo", () => {
    const result = explainPriceRecommendation(baseInput());
    expect(result.fullText.startsWith(result.headline)).toBe(true);
    for (const f of result.factors) {
      expect(result.fullText).toContain(f.text);
    }
  });

  it("redacta el texto del factor pickup con la dirección correcta ('por encima'/'por debajo')", () => {
    const arriba = explainPriceRecommendation(baseInput({ factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 12.34 }] }));
    expect(arriba.factors[0]!.text).toContain("por encima");
    expect(arriba.factors[0]!.text).toContain("12.3%");

    const abajo = explainPriceRecommendation(baseInput({ factors: [{ kind: "pickup", onTheBooksVsExpectedPct: -8 }] }));
    expect(abajo.factors[0]!.text).toContain("por debajo");
  });

  it("nunca usa un LLM: la salida es puramente una función de plantilla de la entrada", () => {
    // No hay ninguna llamada async/fetch en el módulo -- explainPriceRecommendation es
    // sincrónica, lo que por construcción excluye cualquier llamada de red a un LLM.
    const result = explainPriceRecommendation(baseInput());
    expect(typeof result.fullText).toBe("string");
  });
});
