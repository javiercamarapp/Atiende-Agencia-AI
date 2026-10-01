import { describe, expect, it } from "vitest";
import { celdaTextoSegura, formatearCentavos, generarReporteOcupacionIngresos, reporteACsv, reporteAPdf } from "../../src/reportes/index.ts";

const rep = generarReporteOcupacionIngresos({
  periodo: { inicio: "2026-03-01", fin: "2026-04-01" },
  moneda: "MXN",
  unidades: [{ id: "u1", nombre: "=HYPERLINK(\"http://x\")", ownerId: "o1", ownerNombre: "Año, \"Ana\"" }],
  reservas: [{ ocupacionId: "r1", unidadId: "u1", canal: "airbnb", inicio: "2026-03-10", fin: "2026-03-14", creadaEn: "x", financiero: { moneda: "MXN", brutoCentavos: 123456, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 123456 } }],
});

describe("formatearCentavos", () => {
  it("formatea sin punto flotante", () => {
    expect(formatearCentavos(123456)).toBe("1234.56");
    expect(formatearCentavos(5)).toBe("0.05");
    expect(formatearCentavos(-1001)).toBe("-10.01");
    expect(formatearCentavos(0)).toBe("0.00");
  });
});

describe("CSV", () => {
  it("lleva BOM UTF-8, CRLF, totales y los montos como decimales", () => {
    const csv = reporteACsv(rep, "unidad");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("Periodo,2026-03-01 a 2026-04-01 (fin exclusivo)");
    expect(csv).toContain("Moneda,MXN");
    expect(csv).toMatch(/TOTAL,1,4,31,12\.90,1234\.56,0\.00,0\.00,0\.00,0\.00,1234\.56,308\.64/);
  });
  it("neutraliza fórmulas en la primera columna y escapa comillas/comas", () => {
    expect(celdaTextoSegura("=1+1")).toBe("'=1+1");
    expect(celdaTextoSegura("@x")).toBe("'@x");
    expect(celdaTextoSegura("Casa")).toBe("Casa");
    const csv = reporteACsv(rep, "unidad");
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    const prop = reporteACsv(rep, "propietario");
    expect(prop).toContain('"Año, ""Ana"""');
  });
});

describe("PDF", () => {
  const bytes = reporteAPdf(rep, "mes");
  const texto = Buffer.from(bytes).toString("latin1");
  it("es un PDF bien formado con xref coherente", () => {
    expect(texto.startsWith("%PDF-1.4")).toBe(true);
    expect(texto.trimEnd().endsWith("%%EOF")).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n/.exec(texto)![1]);
    expect(texto.slice(startxref, startxref + 4)).toBe("xref");
    const entradas = [...texto.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    entradas.forEach((off, i) => expect(texto.slice(off, off + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
  it("incluye el título, el mes y el total, y escapa paréntesis", () => {
    expect(texto).toContain("Reporte de ocupacion e ingresos");
    expect(texto).toContain("2026-03");
    expect(texto).toContain("TOTAL");
    const raro = generarReporteOcupacionIngresos({ periodo: { inicio: "2026-03-01", fin: "2026-03-05" }, moneda: "MXN", unidades: [{ id: "u", nombre: "Casa (A)\\B ñ 日本", ownerId: null, ownerNombre: null }], reservas: [] });
    const t = Buffer.from(reporteAPdf(raro, "unidad")).toString("latin1");
    expect(t).toContain("Casa \\(A\\)\\\\B");
    expect(t).toContain("?");
  });
  it("pagina cuando hay muchas filas", () => {
    const unidades = Array.from({ length: 120 }, (_, i) => ({ id: `u${i}`, nombre: `Unidad ${i}`, ownerId: null, ownerNombre: null }));
    const grande = generarReporteOcupacionIngresos({ periodo: { inicio: "2026-03-01", fin: "2026-03-05" }, moneda: "MXN", unidades, reservas: [] });
    const t = Buffer.from(reporteAPdf(grande, "unidad")).toString("latin1");
    expect(Number(/\/Count (\d+)/.exec(t)![1])).toBeGreaterThan(1);
  });
});
