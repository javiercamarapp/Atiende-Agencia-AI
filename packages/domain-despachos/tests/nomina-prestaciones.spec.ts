// Prestaciones: vacaciones art. 76 reformado, aguinaldo proporcional, factor de integración, exentos art. 93 y PTU art. 127.
import { describe, expect, it } from "vitest";
import {
  aplicarTopePtu,
  calcularAguinaldo,
  calcularAguinaldoProporcional,
  calcularPrimaVacacional,
  diasVacacionesPorAntiguedad,
  exentoAguinaldo,
  exentoPrimaVacacional,
  exentoPtu,
  exentoTiempoExtra,
  factorIntegracion,
} from "../src/nomina/prestaciones.ts";

const UMA = 117.31;

describe("vacaciones por antigüedad (art. 76 LFT reformado)", () => {
  it.each([
    [0, 0],
    [1, 12],
    [2, 14],
    [5, 20],
    [6, 22],
    [10, 22],
    [11, 24],
    [25, 28],
    [26, 30],
  ])("%i años -> %i días", (anios, dias) => {
    expect(diasVacacionesPorAntiguedad(anios)).toBe(dias);
  });
});

describe("factor de integración", () => {
  it("año 1 = 1.0493 (no 1.0452) y crece con la antigüedad", () => {
    expect(factorIntegracion(1)).toBe(1.0493);
    expect(factorIntegracion(0)).toBe(1.0493);
    expect(factorIntegracion(6)).toBe(1.0562);
    expect(factorIntegracion(25)).toBe(1.0603);
  });
});

describe("aguinaldo y prima vacacional", () => {
  it("aguinaldo anual 15 días y proporcional por días trabajados", () => {
    expect(calcularAguinaldo(500)).toBe(7500);
    expect(calcularAguinaldoProporcional(500, 365)).toBe(7500);
    expect(calcularAguinaldoProporcional(500, 73)).toBe(1500);
    expect(calcularAguinaldoProporcional(500, 900)).toBe(7500);
    expect(calcularAguinaldoProporcional(-5, 100)).toBe(0);
  });

  it("prima vacacional por omisión sobre 12 días (no los 6 derogados)", () => {
    expect(calcularPrimaVacacional(500)).toBe(1500);
    expect(calcularPrimaVacacional(500, 6)).toBe(750);
  });
});

describe("exentos del art. 93 LISR", () => {
  it("aguinaldo exento hasta 30 UMA", () => {
    expect(exentoAguinaldo(3000, UMA)).toEqual({ total: 3000, exento: 3000, gravado: 0 });
    expect(exentoAguinaldo(10000, UMA)).toEqual({ total: 10000, exento: 3519.3, gravado: 6480.7 });
  });
  it("prima vacacional exenta hasta 15 UMA y PTU hasta 15 UMA", () => {
    expect(exentoPrimaVacacional(2000, UMA).exento).toBe(1759.65);
    expect(exentoPtu(1759.65, UMA).gravado).toBe(0);
    expect(exentoPtu(1759.66, UMA).gravado).toBe(0.01);
  });
  it("tiempo extra: dobles exentos al 50 % con tope de 5 UMA por semana; triples gravados", () => {
    expect(exentoTiempoExtra(1000, 0, 1, UMA)).toEqual({ total: 1000, exento: 500, gravado: 500 });
    expect(exentoTiempoExtra(5000, 0, 1, UMA).exento).toBe(586.55); // tope 5 × 117.31
    expect(exentoTiempoExtra(5000, 0, 2, UMA).exento).toBe(1173.1);
    expect(exentoTiempoExtra(0, 800, 1, UMA)).toEqual({ total: 800, exento: 0, gravado: 800 });
  });
});

describe("PTU con topes del art. 127 LFT", () => {
  it("tope = tres meses de salario cuando no hay historial", () => {
    expect(aplicarTopePtu(50000, 500)).toEqual({ ptuCalculada: 50000, tope: 45000, topado: true, monto: 45000 });
  });
  it("usa el promedio de los últimos tres años si es más favorable", () => {
    expect(aplicarTopePtu(60000, 500, [60000, 50000, 70000])).toMatchObject({ tope: 60000, topado: false, monto: 60000 });
  });
  it("por debajo del tope se paga completa", () => {
    expect(aplicarTopePtu(1000, 500).monto).toBe(1000);
  });
});
