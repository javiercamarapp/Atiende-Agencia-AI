import { describe, expect, it } from "vitest";
import { PickupSignalError, computePickupSignal } from "../src/revenue/pickupSignal.ts";
import type { PickupHistoricalSample } from "../src/revenue/pickupSignal.ts";

// 2026-06-06 es sábado.
const TARGET_FECHA = "2026-06-06";

function sabadosHistoricos(values: readonly number[]): PickupHistoricalSample[] {
  // Sábados pasados reales (para que weekdayOfISODate calce con TARGET_FECHA).
  const sabados = ["2026-05-30", "2026-05-23", "2026-05-16", "2026-05-09", "2026-05-02", "2026-04-25", "2026-04-18", "2026-04-11"];
  return values.map((onTheBooksRooms, i) => ({ fecha: sabados[i]!, onTheBooksRooms }));
}

describe("computePickupSignal", () => {
  it("usa el mismo día de la semana cuando hay suficiente historia (>=4 muestras)", () => {
    const result = computePickupSignal({
      fecha: TARGET_FECHA,
      leadTimeDays: 14,
      onTheBooksRoomsNow: 24,
      historicalSamples: sabadosHistoricos([20, 20, 20, 20]),
    });
    expect(result.basis).toBe("mismo_dia_semana");
    expect(result.hasSufficientHistory).toBe(true);
    expect(result.expectedOnTheBooksRooms).toBe(20);
    expect(result.onTheBooksVsExpectedPct).toBeCloseTo(20, 5); // (24-20)/20*100
    expect(result.recommendation).toBe("subir_tarifa");
  });

  it("cae a 'cualquier_dia' si no hay suficientes muestras del mismo día pero sí en total", () => {
    const historicalSamples: PickupHistoricalSample[] = [
      { fecha: "2026-05-31", onTheBooksRooms: 10 }, // domingo, día distinto
      { fecha: "2026-06-01", onTheBooksRooms: 10 },
      { fecha: "2026-06-02", onTheBooksRooms: 10 },
      { fecha: "2026-06-03", onTheBooksRooms: 10 },
      { fecha: "2026-06-04", onTheBooksRooms: 10 },
      { fecha: "2026-06-05", onTheBooksRooms: 10 },
      { fecha: "2026-05-25", onTheBooksRooms: 10 },
      { fecha: "2026-05-26", onTheBooksRooms: 10 },
    ];
    const result = computePickupSignal({ fecha: TARGET_FECHA, leadTimeDays: 14, onTheBooksRoomsNow: 5, historicalSamples });
    expect(result.basis).toBe("cualquier_dia");
    expect(result.hasSufficientHistory).toBe(true);
    expect(result.onTheBooksVsExpectedPct).toBeCloseTo(-50, 5);
    expect(result.recommendation).toBe("bajar_tarifa_o_promocion");
  });

  it("fallback conservador: sin historia suficiente, nunca inventa una tendencia (0%, neutral)", () => {
    const result = computePickupSignal({
      fecha: TARGET_FECHA,
      leadTimeDays: 14,
      onTheBooksRoomsNow: 30,
      historicalSamples: sabadosHistoricos([1, 2]), // solo 2 muestras, insuficiente para ambos umbrales
    });
    expect(result.basis).toBe("sin_historia_suficiente");
    expect(result.hasSufficientHistory).toBe(false);
    expect(result.onTheBooksVsExpectedPct).toBe(0);
    expect(result.recommendation).toBe("mantener");
    expect(result.expectedOnTheBooksRooms).toBeNull();
  });

  it("maneja pickup_esperado = 0 sin división entre cero (property nueva)", () => {
    const conReservas = computePickupSignal({
      fecha: TARGET_FECHA,
      leadTimeDays: 14,
      onTheBooksRoomsNow: 5,
      historicalSamples: sabadosHistoricos([0, 0, 0, 0]),
    });
    expect(conReservas.expectedWasZero).toBe(true);
    expect(conReservas.onTheBooksVsExpectedPct).toBe(100);

    const sinReservas = computePickupSignal({
      fecha: TARGET_FECHA,
      leadTimeDays: 14,
      onTheBooksRoomsNow: 0,
      historicalSamples: sabadosHistoricos([0, 0, 0, 0]),
    });
    expect(sinReservas.onTheBooksVsExpectedPct).toBe(0);
  });

  it("dentro del umbral (default 10%) recomienda mantener", () => {
    const result = computePickupSignal({
      fecha: TARGET_FECHA,
      leadTimeDays: 14,
      onTheBooksRoomsNow: 21,
      historicalSamples: sabadosHistoricos([20, 20, 20, 20]),
    });
    expect(result.onTheBooksVsExpectedPct).toBeCloseTo(5, 5);
    expect(result.recommendation).toBe("mantener");
  });

  it("rechaza fecha inválida", () => {
    expect(() => computePickupSignal({ fecha: "no-es-fecha", leadTimeDays: 1, onTheBooksRoomsNow: 1, historicalSamples: [] })).toThrow(PickupSignalError);
  });

  it("rechaza leadTimeDays negativo y on-the-books negativo", () => {
    expect(() => computePickupSignal({ fecha: TARGET_FECHA, leadTimeDays: -1, onTheBooksRoomsNow: 1, historicalSamples: [] })).toThrow(/lead_time_invalido/);
    expect(() => computePickupSignal({ fecha: TARGET_FECHA, leadTimeDays: 1, onTheBooksRoomsNow: -1, historicalSamples: [] })).toThrow(/on_the_books_invalido/);
  });
});
