// Parsers de estado de cuenta CSV/OFX (D-03) con fixtures SINTÉTICOS (sin datos reales).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clabeValida, detectarFormato, parsearEstadoDeCuenta } from "../src/conciliacion/estado-de-cuenta/index.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "estados-de-cuenta");
const leer = (n: string) => readFileSync(join(DIR, n), "utf8");

describe("CLABE", () => {
  it("valida el dígito verificador (Circular 14/2017)", () => {
    expect(clabeValida("012180000123456782")).toBe(true);
    expect(clabeValida("012180000123456783")).toBe(false);
    expect(clabeValida("12345")).toBe(false);
  });
});

describe("bancos mexicanos (CSV)", () => {
  it("BBVA: preámbulo, delimitador ';', cargos/abonos separados, acentos", () => {
    const r = parsearEstadoDeCuenta(leer("bbva.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("bbva");
    expect(r.bancoDetectado).toBe(true);
    expect(r.cuenta).toBe("012180000123456782");
    expect(r.movimientos).toHaveLength(4);
    expect(r.movimientos[0]).toMatchObject({ fecha: "2026-01-05", abono: 12500, cargo: null, monto: 12500, saldo: 112500, renglon: 5 });
    expect(r.movimientos[1]).toMatchObject({ descripcion: "PAGO DE NÓMINA QUINCENA 1", cargo: 45300.5, abono: null, monto: -45300.5 });
    expect(r.periodo).toEqual({ desde: "2026-01-05", hasta: "2026-01-15" });
    expect(r.totalAbonos).toBe(12500);
    expect(r.totalCargos).toBe(49030.5);
    expect(r.advertencias.filter((a) => a.codigo === "saldo_discontinuo")).toEqual([]);
  });

  it("Banorte: celdas entre comillas con coma, columna Cuenta por renglón, Depósitos/Retiros", () => {
    const r = parsearEstadoDeCuenta(leer("banorte.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("banorte");
    expect(r.cuenta).toBe("072180000123456780");
    expect(r.movimientos).toHaveLength(3);
    expect(r.movimientos[0]).toMatchObject({ descripcion: "DEPÓSITO EN EFECTIVO, VENTANILLA", abono: 8000, fecha: "2026-02-02", referencia: "0000451" });
    expect(r.movimientos[2]).toMatchObject({ cargo: 10000, monto: -10000 });
  });

  it("Santander: columna Cargo/Abono con +/- e Importe sin signo; Hora se ignora", () => {
    const r = parsearEstadoDeCuenta(leer("santander.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("santander");
    expect(r.movimientos.map((m) => m.monto)).toEqual([25000, -4100.75, -5.8]);
    expect(r.movimientos[0]!.referencia).toBe("2602120001");
    expect(r.movimientos[0]!.descripcion).toBe("SPEI RECIBIDO");
  });

  it("HSBC: dd-mm-aaaa y columnas Retiros antes de Depósitos", () => {
    const r = parsearEstadoDeCuenta(leer("hsbc.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("generico"); // sin nombre de banco ni CLABE: no se inventa
    expect(r.advertencias.map((a) => a.codigo)).toContain("banco_no_detectado");
    expect(r.movimientos.map((m) => [m.fecha, m.monto])).toEqual([
      ["2026-03-02", 7250],
      ["2026-03-05", -1500],
      ["2026-03-05", -0.93],
    ]);
  });

  it("HSBC con banco indicado por el usuario", () => {
    const r = parsearEstadoDeCuenta(leer("hsbc.csv"), { banco: "hsbc" });
    expect(r.banco).toBe("hsbc");
    expect(r.bancoDetectado).toBe(false);
    expect(r.advertencias.map((a) => a.codigo)).not.toContain("banco_no_detectado");
  });

  it("Scotiabank: TSV, meses en español abreviados (ENE, FEB, SEPT) y CLABE en el preámbulo", () => {
    const r = parsearEstadoDeCuenta(leer("scotiabank.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("scotiabank");
    expect(r.cuenta).toBe("044180000123456789");
    expect(r.movimientos.map((m) => m.fecha)).toEqual(["2026-01-03", "2026-02-07", "2026-09-11"]);
    expect(r.movimientos[2]!.monto).toBe(12.34);
  });

  it("Citibanamex: todo entrecomillado, celdas vacías entrecomilladas", () => {
    const r = parsearEstadoDeCuenta(leer("banamex.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("banamex");
    expect(r.movimientos.map((m) => m.monto)).toEqual([9900, -2000]);
  });

  it("Inbursa: importe único con signo, paréntesis contable, año de 2 dígitos y fila TOTAL ignorada", () => {
    const r = parsearEstadoDeCuenta(leer("inbursa.csv"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("inbursa");
    expect(r.movimientos.map((m) => [m.fecha, m.monto])).toEqual([
      ["2026-04-01", 5000],
      ["2026-04-02", -899],
      ["2026-04-03", -15],
    ]);
    expect(r.renglonesLeidos).toBe(3);
  });
});

describe("errores por renglón (no abortan el archivo)", () => {
  const csv = [
    "Fecha,Descripción,Cargo,Abono,Saldo",
    "05/01/2026,OK UNO,,100.00,100.00",
    "31/02/2026,FECHA IMPOSIBLE,,50.00,150.00",
    "06/01/2026,IMPORTE RARO,abc,,150.00",
    "07/01/2026,CARGO Y ABONO,10.00,20.00,160.00",
    "08/01/2026,SIN IMPORTE,,,160.00",
    "09/01/2026,OK DOS,40.00,,120.00",
    "01/15/2026,MES 15,,1.00,121.00",
  ].join("\n");

  it("cada renglón malo se reporta con su número de línea y código; los buenos pasan", () => {
    const r = parsearEstadoDeCuenta(csv);
    expect(r.movimientos.map((m) => m.descripcion)).toEqual(["OK UNO", "OK DOS"]);
    expect(r.errores.map((e) => [e.renglon, e.codigo, e.campo])).toEqual([
      [3, "fecha_invalida", "fecha"],
      [4, "importe_invalido", "cargo"],
      [5, "cargo_y_abono", "fila"],
      [6, "sin_importe", "importe"],
      [8, "fecha_invalida", "fecha"],
    ]);
    expect(r.errores[0]!.mensaje).toContain("31/02/2026");
    expect(r.renglonesLeidos).toBe(7);
  });

  it("sin fila de encabezados reconocible: error claro, cero movimientos", () => {
    const r = parsearEstadoDeCuenta("hola,mundo\n1,2\n");
    expect(r.movimientos).toEqual([]);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]!.mensaje).toContain("encabezados");
  });

  it("archivo vacío no lanza", () => {
    expect(parsearEstadoDeCuenta("").errores).toHaveLength(1);
    expect(parsearEstadoDeCuenta("﻿").movimientos).toEqual([]);
  });

  it("BOM, CRLF y campos con salto de línea entre comillas conservan el número de renglón", () => {
    const texto = "﻿Fecha;Descripción;Cargo;Abono\r\n05/01/2026;\"LINEA 1\r\nLINEA 2\";;10.00\r\n99/01/2026;MALA;;1.00\r\n";
    const r = parsearEstadoDeCuenta(texto);
    expect(r.movimientos).toHaveLength(1);
    expect(r.movimientos[0]!.descripcion).toBe("LINEA 1 LINEA 2");
    expect(r.errores[0]!.renglon).toBe(4);
  });

  it("cargo con signo negativo en la columna de cargos sigue siendo salida (no se invierte)", () => {
    const r = parsearEstadoDeCuenta("Fecha,Descripción,Cargo,Abono\n05/01/2026,X,-500.00,\n06/01/2026,Y,(75.50),");
    expect(r.movimientos.map((m) => m.monto)).toEqual([-500, -75.5]);
  });

  it("importe 0.00 se omite con advertencia (no es error)", () => {
    const r = parsearEstadoDeCuenta("Fecha,Descripción,Importe\n05/01/2026,AJUSTE,0.00\n06/01/2026,Z,5.00");
    expect(r.movimientos).toHaveLength(1);
    expect(r.advertencias.map((a) => a.codigo)).toContain("monto_cero");
    expect(r.errores).toEqual([]);
  });

  it("naturaleza desconocida con importe único es error de renglón", () => {
    const r = parsearEstadoDeCuenta("Fecha,Descripción,Tipo,Importe\n05/01/2026,X,QUIZAS,5.00");
    expect(r.errores[0]).toMatchObject({ codigo: "tipo_desconocido", renglon: 2 });
  });

  it("tope de renglones: un archivo gigante no se procesa completo", () => {
    const filas = Array.from({ length: 5_010 }, (_, i) => `05/01/2026,MOV ${i},,1.00`);
    const r = parsearEstadoDeCuenta(["Fecha,Descripción,Cargo,Abono", ...filas].join("\n"));
    expect(r.movimientos.length).toBeLessThanOrEqual(5_000);
    expect(r.errores.some((e) => e.mensaje.includes("5000"))).toBe(true);
  });
});

describe("OFX", () => {
  it("detectarFormato distingue OFX de CSV", () => {
    expect(detectarFormato(leer("cuenta-ofx-sgml.ofx"))).toBe("ofx");
    expect(detectarFormato(leer("cuenta-ofx-xml.ofx"))).toBe("ofx");
    expect(detectarFormato(leer("bbva.csv"))).toBe("csv");
  });

  it("OFX 1.x SGML (hojas sin cierre): banco por CLABE, saldo LEDGERBAL, fecha con zona", () => {
    const r = parsearEstadoDeCuenta(leer("cuenta-ofx-sgml.ofx"));
    expect(r.errores).toEqual([]);
    expect(r.formato).toBe("ofx");
    expect(r.banco).toBe("banorte");
    expect(r.cuenta).toBe("072180000123456780");
    expect(r.moneda).toBe("MXN");
    expect(r.saldoFinal).toBe(66949.5);
    expect(r.movimientos.map((m) => [m.fecha, m.monto, m.descripcion])).toEqual([
      ["2026-01-05", 12500, "SPEI RECIBIDO CLIENTE ACME REF 0501"],
      ["2026-01-08", -45300.5, "PAGO DE NÓMINA"],
      ["2026-01-10", -250, "COMISION"], // NAME == MEMO no se duplica
    ]);
    expect(r.movimientos[0]!.cargo).toBeNull();
    expect(r.movimientos[1]!.abono).toBeNull();
  });

  it("OFX 2.x XML: entidades, miles con coma y decimales cortos", () => {
    const r = parsearEstadoDeCuenta(leer("cuenta-ofx-xml.ofx"));
    expect(r.errores).toEqual([]);
    expect(r.banco).toBe("bbva");
    expect(r.saldoFinal).toBe(800.5);
    expect(r.movimientos.map((m) => [m.monto, m.descripcion])).toEqual([
      [1000, "DEPÓSITO & AJUSTE"],
      [-200.5, "PAGO Servicios"],
    ]);
  });

  it("OFX con renglones malos: reporta y sigue", () => {
    const ofx = `<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>20260230<TRNAMT>10.00<NAME>FECHA MALA</STMTTRN>
<STMTTRN><DTPOSTED>20260105<TRNAMT>abc<NAME>MONTO MALO</STMTTRN>
<STMTTRN><DTPOSTED>20260105<NAME>SIN MONTO</STMTTRN>
<STMTTRN><DTPOSTED>20260106<TRNAMT>5.00<NAME>BUENO</STMTTRN>
</BANKTRANLIST></OFX>`;
    const r = parsearEstadoDeCuenta(ofx);
    expect(r.movimientos).toHaveLength(1);
    expect(r.errores.map((e) => [e.renglon, e.codigo])).toEqual([
      [1, "fecha_invalida"],
      [2, "importe_invalido"],
      [3, "sin_importe"],
    ]);
  });

  it("OFX con varias cuentas se rechaza (un archivo por cuenta)", () => {
    const ofx = "<OFX><ACCTID>111111111111<ACCTID>222222222222<STMTTRN><DTPOSTED>20260105<TRNAMT>1.00</STMTTRN></OFX>";
    const r = parsearEstadoDeCuenta(ofx, { formato: "ofx" });
    expect(r.movimientos).toEqual([]);
    expect(r.errores[0]!.codigo).toBe("ofx_invalido");
  });

  it("texto que no es OFX forzado como OFX: error, no excepción", () => {
    const r = parsearEstadoDeCuenta("Fecha,Monto\n1,2", { formato: "ofx" });
    expect(r.errores[0]!.codigo).toBe("ofx_invalido");
  });
});
