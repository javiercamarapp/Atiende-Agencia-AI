import { describe, expect, it } from "vitest";
import {
  computeEasterSunday,
  nthWeekdayOfMonth,
  isTransmisionPoderEjecutivoYear,
  getFederalHolidays,
  getTemporadaAltaRanges,
  evaluateDemandaFecha,
} from "../src/revenue/calendarioMexico.ts";

// Domingos de Pascua REALES conocidos (calendario gregoriano) -- fuente: efemérides
// astronómicas/eclesiásticas estándar. Cubren un rango de años amplio a propósito
// (no solo años consecutivos) para que un algoritmo que solo "memorizara" un
// patrón local no pase por casualidad.
const KNOWN_EASTER_SUNDAYS: ReadonlyArray<{ year: number; month: number; day: number }> = [
  { year: 2019, month: 4, day: 21 },
  { year: 2020, month: 4, day: 12 },
  { year: 2021, month: 4, day: 4 },
  { year: 2022, month: 4, day: 17 },
  { year: 2023, month: 4, day: 9 },
  { year: 2024, month: 3, day: 31 },
  { year: 2025, month: 4, day: 20 },
  { year: 2026, month: 4, day: 5 },
  { year: 2027, month: 3, day: 28 },
  { year: 2028, month: 4, day: 16 },
  { year: 2030, month: 4, day: 21 },
  { year: 2000, month: 4, day: 23 },
  { year: 1994, month: 4, day: 3 },
];

describe("computeEasterSunday", () => {
  for (const { year, month, day } of KNOWN_EASTER_SUNDAYS) {
    it(`calcula el Domingo de Pascua de ${year} correctamente (${year}-${month}-${day})`, () => {
      expect(computeEasterSunday(year)).toEqual({ month, day });
    });
  }

  it("rechaza un año no entero", () => {
    expect(() => computeEasterSunday(2024.5)).toThrow(/anio_invalido/);
  });
});

describe("nthWeekdayOfMonth", () => {
  it("primer lunes de febrero 2024 es el 5 de febrero", () => {
    // 1-feb-2024 es jueves -> el primer lunes es el 5.
    expect(nthWeekdayOfMonth(2024, 2, 1, 1)).toBe(5);
  });

  it("tercer lunes de marzo 2024 es el 18 de marzo", () => {
    expect(nthWeekdayOfMonth(2024, 3, 1, 3)).toBe(18);
  });

  it("tercer lunes de noviembre 2026 es el 16 de noviembre", () => {
    // 1-nov-2026 es domingo -> primer lunes 2, segundo 9, tercero 16.
    expect(nthWeekdayOfMonth(2026, 11, 1, 3)).toBe(16);
  });

  it("lanza si el mes no tiene una 5ª ocurrencia de ese día", () => {
    expect(() => nthWeekdayOfMonth(2024, 2, 1, 5)).toThrow(/ocurrencia_invalida/);
  });
});

describe("isTransmisionPoderEjecutivoYear", () => {
  it("reconoce los años reales de transmisión conocidos (1994-2024, cada 6 años)", () => {
    for (const y of [1994, 2000, 2006, 2012, 2018, 2024]) {
      expect(isTransmisionPoderEjecutivoYear(y)).toBe(true);
    }
  });

  it("proyecta correctamente hacia el futuro sin hardcodear la lista", () => {
    expect(isTransmisionPoderEjecutivoYear(2030)).toBe(true);
    expect(isTransmisionPoderEjecutivoYear(2036)).toBe(true);
  });

  it("rechaza años que no son de transmisión", () => {
    for (const y of [2023, 2025, 2026, 2027, 2028, 2029]) {
      expect(isTransmisionPoderEjecutivoYear(y)).toBe(false);
    }
  });
});

describe("getFederalHolidays", () => {
  it("2026: 8 festivos (sin año de transmisión)", () => {
    const holidays = getFederalHolidays(2026);
    expect(holidays.map((h) => h.fecha)).toEqual([
      "2026-01-01",
      "2026-02-02", // primer lunes de febrero 2026 (1-feb-2026 es domingo)
      "2026-03-16", // tercer lunes de marzo 2026
      "2026-05-01",
      "2026-09-16",
      "2026-11-16",
      "2026-12-25",
    ]);
  });

  it("2024: 8 festivos (año de transmisión del Poder Ejecutivo)", () => {
    const holidays = getFederalHolidays(2024);
    expect(holidays).toHaveLength(8);
    expect(holidays.find((h) => h.kind === "transmision_poder_ejecutivo")?.fecha).toBe("2024-12-01");
  });

  it("las fechas vienen en orden cronológico total", () => {
    const holidays = getFederalHolidays(2024);
    for (let i = 1; i < holidays.length; i++) {
      expect(holidays[i]!.fecha > holidays[i - 1]!.fecha).toBe(true);
    }
  });
});

describe("getTemporadaAltaRanges", () => {
  it("Semana Santa/Pascua 2026 rodea el Domingo de Pascua real (2026-04-05)", () => {
    const ranges = getTemporadaAltaRanges(2026);
    const semanaSanta = ranges.find((r) => r.tipo === "semana_santa_pascua")!;
    expect(semanaSanta.inicio).toBe("2026-03-29"); // domingo de Ramos = Pascua - 7 días
    expect(semanaSanta.fin).toBe("2026-04-12"); // Pascua + 7 días
    expect(semanaSanta.fechasExactas).toBe(true);
  });

  it("puente_verano se marca explícitamente como aproximado", () => {
    const ranges = getTemporadaAltaRanges(2026);
    const verano = ranges.find((r) => r.tipo === "puente_verano")!;
    expect(verano.fechasExactas).toBe(false);
  });

  it("temporada decembrina cruza el fin de año hacia el Día de Reyes", () => {
    const ranges = getTemporadaAltaRanges(2026);
    const decembrina = ranges.find((r) => r.tipo === "temporada_decembrina")!;
    expect(decembrina.inicio).toBe("2026-12-15");
    expect(decembrina.fin).toBe("2027-01-06");
  });
});

describe("evaluateDemandaFecha", () => {
  it("marca el 25 de diciembre como alta demanda (festivo + temporada decembrina)", () => {
    const r = evaluateDemandaFecha("2026-12-25");
    expect(r.esAltaDemanda).toBe(true);
    expect(r.eventos.length).toBeGreaterThanOrEqual(2);
    expect(r.eventos).toContain("Navidad");
  });

  it("marca el Domingo de Pascua real de 2026 como alta demanda", () => {
    const r = evaluateDemandaFecha("2026-04-05");
    expect(r.esAltaDemanda).toBe(true);
    expect(r.eventos.some((e) => e.includes("Semana Santa"))).toBe(true);
    expect(r.fechasExactas).toBe(true);
  });

  it("un día ordinario de baja demanda (ej. un martes de febrero fuera de festivo) no marca nada", () => {
    const r = evaluateDemandaFecha("2026-02-17");
    expect(r.esAltaDemanda).toBe(false);
    expect(r.eventos).toEqual([]);
  });

  it("marca fechasExactas=false cuando la única cobertura es la aproximación de verano", () => {
    const r = evaluateDemandaFecha("2026-07-15");
    expect(r.esAltaDemanda).toBe(true);
    expect(r.fechasExactas).toBe(false);
  });

  it("1 de enero de un año de transmisión no lo confunde con el 1 de diciembre del año anterior", () => {
    const r = evaluateDemandaFecha("2025-01-01");
    expect(r.eventos).toContain("Año Nuevo");
  });

  it("rechaza una fecha con formato inválido", () => {
    expect(() => evaluateDemandaFecha("05-01-2025")).toThrow(/fecha_invalida/);
  });
});
