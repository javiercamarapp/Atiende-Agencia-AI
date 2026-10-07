// Rn-P3-06 -- parser del reporte de pagos de Airbnb contra una fixture ANONIMIZADA (estructura del historial de transacciones; no es un
// export real). Cubre montos en centavos, signos, filas de ajuste/resolucion, la fila informativa de payout, errores y huellas estables.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { leerCsv } from "../../src/finanzas/csv/lector.ts";
import { parsearReportePagos } from "../../src/finanzas/csv/index.ts";
import { parsearReporteAirbnb } from "../../src/finanzas/csv/airbnb.ts";
import { centavosDesdeTextoMonto } from "../../src/finanzas/csv/tipos.ts";
import { RentasDomainError } from "../../src/errors.ts";

const FIXTURE = readFileSync(new URL("../fixtures/pagos/airbnb-transacciones.csv", import.meta.url), "utf8");

describe("centavosDesdeTextoMonto", () => {
  it("acepta miles con coma, decimales y signo; redondea half-up a centavos", () => {
    expect(centavosDesdeTextoMonto("8,730.00")).toBe(873000);
    expect(centavosDesdeTextoMonto("-270.5")).toBe(-27050);
    expect(centavosDesdeTextoMonto("0.005")).toBe(1);
    expect(centavosDesdeTextoMonto("12")).toBe(1200);
  });
  it("rechaza formatos ambiguos o con simbolos en vez de adivinar", () => {
    for (const t of ["", "$12.00", "12,5", "1.234,50", "abc", "1,23", "--1", "12.00 MXN"]) expect(centavosDesdeTextoMonto(t)).toBeNull();
  });
});

describe("leerCsv", () => {
  it("campos entre comillas con comas, comillas dobles y saltos de linea; BOM y CRLF", () => {
    const filas = leerCsv('﻿a,b\r\n"x, y","di ""hola""\nlinea2"\r\n');
    expect(filas).toEqual([["a", "b"], ["x, y", 'di "hola"\nlinea2']]);
  });
  it("rechaza comillas sin cerrar y archivos por encima del tope", () => {
    expect(() => leerCsv('a,"b')).toThrow(RentasDomainError);
    expect(() => leerCsv("x".repeat(2 * 1024 * 1024 + 1))).toThrow(/excede/);
  });
});

describe("parsearReporteAirbnb", () => {
  const r = parsearReporteAirbnb(FIXTURE);

  it("separa reservas, ajustes y filas informativas", () => {
    expect(r.errores).toEqual([]);
    expect(r.ignoradas).toBe(1);
    expect(r.lineas.map((l) => [l.tipoLinea, l.codigoConfirmacion])).toEqual([["reserva", "HMAB12CD34"], ["reserva", "HMZZ99YY88"], ["ajuste", "HMAB12CD34"]]);
  });

  it("neto = Paid out, bruto = Gross earnings y comision implicita = bruto - neto (en centavos)", () => {
    const [a, b] = r.lineas;
    expect(a).toMatchObject({ montoNetoCentavos: 873000, montoBrutoCentavos: 900000, comisionCanalCentavos: 27000, moneda: "MXN" });
    expect(b).toMatchObject({ montoNetoCentavos: 450000, montoBrutoCentavos: 463900, comisionCanalCentavos: 13900 });
  });

  it("un monto negativo o un tipo distinto de Reservation es ajuste con signo conservado, nunca una reserva", () => {
    const ajuste = r.lineas[2]!;
    expect(ajuste.montoNetoCentavos).toBe(-35000);
    expect(ajuste.tipoOriginal).toBe("Resolution Adjustment");
  });

  it("la fecha solo se interpreta si es inequivoca (un componente > 12); si es ambigua queda null y la huella usa el texto crudo", () => {
    expect(r.lineas[0]!.fecha).toBe("2026-10-16");
    const ambigua = parsearReporteAirbnb("Date,Type,Confirmation Code,Currency,Paid out\n03/04/2026,Reservation,HMAAAAAAAA,MXN,10\n");
    expect(ambigua.lineas[0]!.fecha).toBeNull();
  });

  it("huellas estables entre corridas y distintas entre lineas", () => {
    const otra = parsearReporteAirbnb(FIXTURE);
    expect(otra.lineas.map((l) => l.huella)).toEqual(r.lineas.map((l) => l.huella));
    expect(new Set(r.lineas.map((l) => l.huella)).size).toBe(3);
  });

  it("dos filas identicas en el mismo archivo obtienen huellas distintas (ordinal)", () => {
    const filaDuplicada = FIXTURE.split("\n")[1]!;
    const doble = parsearReporteAirbnb(FIXTURE + filaDuplicada + "\n");
    const huellas = doble.lineas.filter((l) => l.codigoConfirmacion === "HMAB12CD34" && l.tipoLinea === "reserva").map((l) => l.huella);
    expect(huellas).toHaveLength(2);
    expect(huellas[0]).not.toBe(huellas[1]);
  });

  it("columnas en otro orden funcionan; faltan columnas minimas -> error claro", () => {
    const reordenado = "Currency,Paid out,Type,Confirmation Code\nMXN,100.00,Reservation,HMAAAAAAAA\n";
    expect(parsearReporteAirbnb(reordenado).lineas[0]).toMatchObject({ tipoLinea: "reserva", montoNetoCentavos: 10000, montoBrutoCentavos: null, comisionCanalCentavos: null });
    expect(() => parsearReporteAirbnb("Fecha,Tipo,Codigo\n1,2,3\n")).toThrow(/No se reconoce el formato/);
  });

  it("filas con moneda o monto invalidos son errores visibles por fila y no entran como lineas", () => {
    const malo = "Type,Confirmation Code,Currency,Paid out\nReservation,HMAAAAAAAA,mxn,10\nReservation,HMBBBBBBBB,MXN,diez\nReservation,HMCCCCCCCC,MXN,5\n";
    const res = parsearReporteAirbnb(malo);
    expect(res.errores.map((e) => e.fila)).toEqual([2, 3]);
    expect(res.lineas).toHaveLength(1);
  });

  it("una reserva sin codigo es ajuste (no hay con que emparejar)", () => {
    const res = parsearReporteAirbnb("Type,Confirmation Code,Currency,Paid out\nReservation,,MXN,10\n");
    expect(res.lineas[0]!.tipoLinea).toBe("ajuste");
  });
});

describe("parsearReportePagos (despacho por canal)", () => {
  it("Booking.com y Vrbo responden formato no soportado todavia", () => {
    for (const canal of ["booking", "vrbo", "manual"]) {
      try {
        parsearReportePagos(canal, FIXTURE);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(RentasDomainError);
        expect((e as RentasDomainError).code).toBe("formato_reporte_no_soportado");
        expect((e as Error).message).toMatch(/todavia no esta soportado/);
      }
    }
  });
});
