// Bordes de importes y fechas de estados de cuenta mexicanos (D-03).
import { describe, expect, it } from "vitest";
import { parsearMonto } from "../src/conciliacion/estado-de-cuenta/montos.ts";
import { parsearFechaMx, parsearFechaOfx } from "../src/conciliacion/estado-de-cuenta/fechas.ts";

function centavos(s: string): number | "vacio" | "error" {
  const r = parsearMonto(s);
  if (!r.ok) return "error";
  return r.vacio ? "vacio" : r.centavos;
}

describe("parsearMonto", () => {
  it.each([
    ["1,234.56", 123456],
    ["$1,234.56", 123456],
    ["  $ 1,234.56  ", 123456],
    ["1234.5", 123450],
    ["0.07", 7],
    ["12,500", 1250000],
    ["1,234,567.89", 123456789],
    ["1.234,56", 123456], // exportación con configuración regional europea
    ["1234,56", 123456],
    ["-500.00", -50000],
    ["500.00-", -50000],
    ["(500.00)", -50000],
    ["+500.00", 50000],
    ["1,200.00 CR", 120000],
    ["1,200.00 DR", -120000],
    ["MXN 99.99", 9999],
    ["10.505", "error"], // 3er decimal distinto de cero: ambiguo, no se redondea en silencio
    ["10.500", 1050], // ceros sobrantes sí se aceptan
    ["10.50", 1050],
    ["1,23,45.00", "error"],
    ["1.2.3", "error"],
    ["abc", "error"],
    ["12.3.4,5", "error"],
    ["", "vacio"],
    ["-", "vacio"],
    ["N/A", "vacio"],
    ["0.00", 0],
    ["-0.00", 0],
  ])("%s -> %s", (entrada, esperado) => {
    expect(centavos(entrada)).toBe(esperado);
  });

  it("no acumula error de punto flotante (0.1 + 0.2 en centavos exactos)", () => {
    const a = parsearMonto("0.10");
    const b = parsearMonto("0.20");
    expect(a.ok && b.ok && !a.vacio && !b.vacio && a.centavos + b.centavos).toBe(30);
  });

  it("espacio duro (NBSP) como separador de miles/moneda no rompe el parseo", () => {
    expect(centavos("$ 1,000.00")).toBe(100000);
  });

  it("rechaza importes fuera del rango seguro", () => {
    expect(centavos("99999999999999999999.99")).toBe("error");
  });
});

describe("parsearFechaMx", () => {
  it.each([
    ["15/01/2026", "2026-01-15"],
    ["5/1/2026", "2026-01-05"],
    ["15-01-2026", "2026-01-15"],
    ["15.01.2026", "2026-01-15"],
    ["2026-01-15", "2026-01-15"],
    ["2026/1/5", "2026-01-05"],
    ["15/01/26", "2026-01-15"],
    ["15/ENE/2026", "2026-01-15"],
    ["15 ene 2026", "2026-01-15"],
    ["03-SEPT-2026", "2026-09-03"],
    ["02-sep-26", "2026-09-02"],
    ["15 de enero de 2026", "2026-01-15"],
    ["28 FEB 2026", "2026-02-28"],
    ["29/02/2028", "2028-02-29"],
    ["15/01/2026 13:45:10", "2026-01-15"],
    ["2026-01-15T10:00:00", "2026-01-15"],
    ["20260115", "2026-01-15"],
    ["15012026", "2026-01-15"],
  ])("%s -> %s", (entrada, esperado) => {
    const r = parsearFechaMx(entrada);
    expect(r.ok && r.iso).toBe(esperado);
  });

  it.each(["31/02/2026", "29/02/2026", "00/01/2026", "15/13/2026", "01/15/2026", "15/XYZ/2026", "", "ayer", "15/01/1800"])("rechaza %j (día primero estricto, nunca intercambia mm/dd)", (entrada) => {
    expect(parsearFechaMx(entrada).ok).toBe(false);
  });

  it("ene/dic con acentos o mayúsculas se reconocen igual", () => {
    expect(parsearFechaMx("10/DIC/2025")).toEqual({ ok: true, iso: "2025-12-10" });
    expect(parsearFechaMx("10/Dic/2025")).toEqual({ ok: true, iso: "2025-12-10" });
  });
});

describe("parsearFechaOfx", () => {
  it.each([
    ["20260105", "2026-01-05"],
    ["20260105120000", "2026-01-05"],
    ["20260105120000.000", "2026-01-05"],
    ["20260105120000[-6:CST]", "2026-01-05"],
  ])("%s -> %s", (entrada, esperado) => {
    const r = parsearFechaOfx(entrada);
    expect(r.ok && r.iso).toBe(esperado);
  });
  it.each(["20260230", "2026-01-05", "", "2026"])("rechaza %j", (entrada) => {
    expect(parsearFechaOfx(entrada).ok).toBe(false);
  });
});
