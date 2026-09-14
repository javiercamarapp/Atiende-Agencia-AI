import { describe, expect, it } from "vitest";
import { BenchmarkGuardError, assertBenchmarkQueryAllowed } from "../src/revenue/compsetGuard.ts";

describe("assertBenchmarkQueryAllowed", () => {
  it("permite una consulta con k>=10, >=12 meses y opinión antimonopolio", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 10, monthsOfHistory: 12, hasAntitrustOpinion: true }),
    ).not.toThrow();
  });

  it("rechaza con menos de 10 competidores (k mínimo)", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 9, monthsOfHistory: 12, hasAntitrustOpinion: true }),
    ).toThrow(BenchmarkGuardError);
  });

  it("rechaza con menos de 12 meses de histórico", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 10, monthsOfHistory: 11, hasAntitrustOpinion: true }),
    ).toThrow(BenchmarkGuardError);
  });

  it("rechaza sin opinión antimonopolio documentada, aunque k y meses cumplan", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 50, monthsOfHistory: 24, hasAntitrustOpinion: false }),
    ).toThrow(BenchmarkGuardError);
  });

  it("el error trae el código estable 'benchmark_k_minimo'", () => {
    expect.assertions(2);
    try {
      assertBenchmarkQueryAllowed({ competitorCount: 1, monthsOfHistory: 1, hasAntitrustOpinion: false });
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkGuardError);
      expect((err as BenchmarkGuardError).code).toBe("benchmark_k_minimo");
    }
  });

  it("un solo hotel-cliente competidor (k=1) nunca es suficiente -- la guarda negativa central de REQ-REV-004", () => {
    expect(() =>
      assertBenchmarkQueryAllowed({ competitorCount: 1, monthsOfHistory: 24, hasAntitrustOpinion: true }),
    ).toThrow(BenchmarkGuardError);
  });
});
