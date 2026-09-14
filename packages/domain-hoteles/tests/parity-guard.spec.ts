import { describe, expect, it } from "vitest";
import {
  ParityGuardError,
  assertValidParityChannelConfig,
  assertValidParityGuardConfig,
  computeParityFloor,
  evaluateParityGuard,
  type ParityGuardConfig,
} from "../src/revenue/parity-guard.ts";

describe("computeParityFloor", () => {
  it("calcula el piso como referencia * (1 - tolerancia/100)", () => {
    expect(computeParityFloor(1000, 5)).toBeCloseTo(950);
    expect(computeParityFloor(1000, 0)).toBe(1000);
  });
});

describe("assertValidParityChannelConfig", () => {
  it("rechaza canal sin nombre", () => {
    expect(() => assertValidParityChannelConfig({ channel: "", referenceRate: 1000, toleranceAllowedPct: 0 })).toThrow(
      ParityGuardError,
    );
  });

  it("rechaza tarifa de referencia <= 0", () => {
    expect(() => assertValidParityChannelConfig({ channel: "booking.com", referenceRate: 0, toleranceAllowedPct: 0 })).toThrow(
      ParityGuardError,
    );
  });

  it("rechaza tolerancia fuera de [0, 100)", () => {
    expect(() =>
      assertValidParityChannelConfig({ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: -1 }),
    ).toThrow(ParityGuardError);
    expect(() =>
      assertValidParityChannelConfig({ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 100 }),
    ).toThrow(ParityGuardError);
  });

  it("acepta tolerancia 0 (paridad estricta)", () => {
    expect(() =>
      assertValidParityChannelConfig({ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 0 }),
    ).not.toThrow();
  });
});

describe("assertValidParityGuardConfig", () => {
  it("rechaza modo inválido", () => {
    expect(() =>
      assertValidParityGuardConfig({ hotelId: "h1", mode: "otro" as never, channels: [] }),
    ).toThrow(ParityGuardError);
  });

  it("rechaza canales duplicados (mismo nombre, distinta capitalización)", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "bloquea",
      channels: [
        { channel: "Booking.com", referenceRate: 1000, toleranceAllowedPct: 5 },
        { channel: "booking.com", referenceRate: 950, toleranceAllowedPct: 0 },
      ],
    };
    expect(() => assertValidParityGuardConfig(config)).toThrow(/canal_duplicado:/);
  });
});

describe("evaluateParityGuard", () => {
  it("sin canales configurados, cualquier tarifa está permitida (nada que proteger)", () => {
    const result = evaluateParityGuard({ hotelId: "h1", mode: "bloquea", channels: [] }, 1);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("una tarifa igual al piso exacto SÍ respeta la paridad (tolerancia inclusiva)", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "bloquea",
      channels: [{ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 5 }],
    };
    const result = evaluateParityGuard(config, 950);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("modo 'bloquea': una tarifa por debajo del piso en cualquier canal no es elegible", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "bloquea",
      channels: [{ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 5 }],
    };
    const result = evaluateParityGuard(config, 900);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.channel).toBe("booking.com");
    expect(result.reasons[0]).toMatch(/^paridad_rota:booking\.com:/);
  });

  it("modo 'alerta': sigue siendo elegible aunque haya violaciones, pero las reporta", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "alerta",
      channels: [{ channel: "expedia", referenceRate: 1000, toleranceAllowedPct: 5 }],
    };
    const result = evaluateParityGuard(config, 900);
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(1);
  });

  it("evalúa la paridad de forma INDEPENDIENTE por canal: respeta uno pero rompe otro", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "bloquea",
      channels: [
        { channel: "expedia", referenceRate: 1000, toleranceAllowedPct: 5 }, // piso 950
        { channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 0 }, // piso 1000
      ],
    };
    const result = evaluateParityGuard(config, 960);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.channel).toBe("booking.com");
  });

  it("calcula deficitPct correctamente sobre el piso, no sobre la referencia", () => {
    const config: ParityGuardConfig = {
      hotelId: "h1",
      mode: "bloquea",
      channels: [{ channel: "booking.com", referenceRate: 1000, toleranceAllowedPct: 0 }],
    };
    const result = evaluateParityGuard(config, 900);
    expect(result.violations[0]!.floorRate).toBe(1000);
    expect(result.violations[0]!.deficitPct).toBeCloseTo(10);
  });

  it("rechaza tarifa propuesta <= 0", () => {
    expect(() => evaluateParityGuard({ hotelId: "h1", mode: "bloquea", channels: [] }, 0)).toThrow(ParityGuardError);
  });

  it("rechaza config inválida aunque no haya violaciones -- nunca disfraza un error de config como 'sin violaciones'", () => {
    expect(() =>
      evaluateParityGuard({ hotelId: "h1", mode: "bloquea", channels: [{ channel: "x", referenceRate: -1, toleranceAllowedPct: 0 }] }, 100),
    ).toThrow(ParityGuardError);
  });
});
