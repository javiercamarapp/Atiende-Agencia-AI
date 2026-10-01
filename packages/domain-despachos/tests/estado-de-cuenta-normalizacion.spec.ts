// Idempotencia por hash, movimientos idénticos y continuidad de saldo (D-03).
import { describe, expect, it } from "vitest";
import { parsearEstadoDeCuenta } from "../src/conciliacion/estado-de-cuenta/index.ts";

const ENC = "Fecha,Descripción,Cargo,Abono,Saldo\n";

describe("hash de idempotencia", () => {
  const base = ENC + "05/01/2026,SPEI RECIBIDO ACME,,100.00,100.00\n06/01/2026,Pago nómina,50.00,,50.00\n";

  it("el mismo archivo parseado dos veces produce exactamente los mismos hashes", () => {
    const a = parsearEstadoDeCuenta(base, { cuenta: "012180000123456782" });
    const b = parsearEstadoDeCuenta(base, { cuenta: "012180000123456782" });
    expect(a.movimientos.map((m) => m.hash)).toEqual(b.movimientos.map((m) => m.hash));
    expect(new Set(a.movimientos.map((m) => m.hash)).size).toBe(2);
    expect(a.movimientos[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("un periodo traslapado (otro archivo) reproduce el hash de los movimientos en común", () => {
    const otro = ENC + "06/01/2026,PAGO NOMINA,50.00,,50.00\n07/01/2026,OTRO,,9.00,59.00\n";
    const a = parsearEstadoDeCuenta(base, { cuenta: "X1" });
    const b = parsearEstadoDeCuenta(otro, { cuenta: "X1" });
    // Mayúsculas/acentos del concepto no cambian la identidad del movimiento.
    expect(b.movimientos[0]!.hash).toBe(a.movimientos[1]!.hash);
    expect(b.movimientos[1]!.hash).not.toBe(a.movimientos[0]!.hash);
  });

  it("no depende de la referencia, del saldo ni del formato de monto", () => {
    const a = parsearEstadoDeCuenta("Fecha,Descripción,Referencia,Importe,Saldo\n05/01/2026,X,R1,\"1,000.00\",5\n", { cuenta: "C" });
    const b = parsearEstadoDeCuenta("Fecha;Descripción;Referencia;Importe;Saldo\n2026-01-05;x;R2;1000;999\n", { cuenta: "C" });
    expect(a.movimientos[0]!.hash).toBe(b.movimientos[0]!.hash);
  });

  it("distingue cuenta, banco, fecha, monto y concepto", () => {
    const h = (csv: string, o: Parameters<typeof parsearEstadoDeCuenta>[1] = { cuenta: "C" }) => parsearEstadoDeCuenta(csv, o).movimientos[0]!.hash;
    const ref = h(ENC + "05/01/2026,X,,1.00,\n");
    expect(h(ENC + "05/01/2026,X,,1.00,\n", { cuenta: "D" })).not.toBe(ref);
    expect(h(ENC + "05/01/2026,X,,1.00,\n", { cuenta: "C", banco: "bbva" })).not.toBe(ref);
    expect(h(ENC + "06/01/2026,X,,1.00,\n")).not.toBe(ref);
    expect(h(ENC + "05/01/2026,X,,1.01,\n")).not.toBe(ref);
    expect(h(ENC + "05/01/2026,Y,,1.00,\n")).not.toBe(ref);
    expect(h(ENC + "05/01/2026,X,1.00,,\n")).not.toBe(ref); // cargo vs abono del mismo importe
  });

  it("dos movimientos idénticos el mismo día se importan ambos con hash distinto y aviso", () => {
    const r = parsearEstadoDeCuenta(ENC + "05/01/2026,DEPOSITO EFECTIVO,,500.00,\n05/01/2026,DEPOSITO EFECTIVO,,500.00,\n05/01/2026,DEPOSITO EFECTIVO,,500.00,\n", { cuenta: "C" });
    expect(r.movimientos).toHaveLength(3);
    expect(r.movimientos.map((m) => m.ocurrencia)).toEqual([1, 2, 3]);
    expect(new Set(r.movimientos.map((m) => m.hash)).size).toBe(3);
    const avisos = r.advertencias.filter((a) => a.codigo === "posible_duplicado");
    expect(avisos.map((a) => a.renglon)).toEqual([3, 4]);
    expect(avisos[0]!.mensaje).toContain("renglón 2");
    // Re-subir el mismo archivo reproduce los 3 hashes.
    const otra = parsearEstadoDeCuenta(ENC + "05/01/2026,DEPOSITO EFECTIVO,,500.00,\n05/01/2026,DEPOSITO EFECTIVO,,500.00,\n05/01/2026,DEPOSITO EFECTIVO,,500.00,\n", { cuenta: "C" });
    expect(otra.movimientos.map((m) => m.hash)).toEqual(r.movimientos.map((m) => m.hash));
  });

  it("OFX: el FITID regenerado en cada descarga NO cambia el hash", () => {
    const o = (fitid: string) => `<OFX><ACCTID>C1<STMTTRN><DTPOSTED>20260105<TRNAMT>10.00<FITID>${fitid}<NAME>SPEI</STMTTRN></OFX>`;
    expect(parsearEstadoDeCuenta(o("A"), { formato: "ofx" }).movimientos[0]!.hash).toBe(parsearEstadoDeCuenta(o("B"), { formato: "ofx" }).movimientos[0]!.hash);
  });
});

describe("continuidad de saldo", () => {
  it("archivo ascendente consistente: sin avisos", () => {
    const r = parsearEstadoDeCuenta(ENC + "01/01/2026,A,,100.00,100.00\n02/01/2026,B,30.00,,70.00\n03/01/2026,C,,5.00,75.00\n");
    expect(r.advertencias.filter((a) => a.codigo === "saldo_discontinuo")).toEqual([]);
  });

  it("archivo descendente (más reciente primero) consistente: sin avisos", () => {
    const r = parsearEstadoDeCuenta(ENC + "03/01/2026,C,,5.00,75.00\n02/01/2026,B,30.00,,70.00\n01/01/2026,A,,100.00,100.00\n");
    expect(r.advertencias.filter((a) => a.codigo === "saldo_discontinuo")).toEqual([]);
  });

  it("un movimiento faltante en medio se señala en su renglón", () => {
    const r = parsearEstadoDeCuenta(ENC + "01/01/2026,A,,100.00,100.00\n02/01/2026,B,30.00,,70.00\n03/01/2026,C,,5.00,75.00\n04/01/2026,D,,1.00,126.00\n05/01/2026,E,,1.00,127.00\n06/01/2026,F,,1.00,128.00\n07/01/2026,G,,1.00,129.00\n08/01/2026,H,,1.00,130.00\n");
    const avisos = r.advertencias.filter((a) => a.codigo === "saldo_discontinuo");
    expect(avisos.map((a) => a.renglon)).toEqual([5]);
  });

  it("saldo que no cuadra en ningún orden: un solo aviso global", () => {
    const r = parsearEstadoDeCuenta(ENC + "01/01/2026,A,,100.00,7.00\n02/01/2026,B,30.00,,900.00\n03/01/2026,C,,5.00,11.00\n04/01/2026,D,,5.00,3.00\n");
    const avisos = r.advertencias.filter((a) => a.codigo === "saldo_discontinuo");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.renglon).toBeNull();
  });
});
