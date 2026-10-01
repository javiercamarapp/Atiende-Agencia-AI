// Vista previa de importación (D-03): reutiliza el motor de conciliación existente, sugiere
// cobranza y degrada contra una base sin migrar (AbortAwareFakeSession reproduce 25P02; una
// sesión falsa plana NO sirve para probar el SAVEPOINT).
import { describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { leerFuenteOpcional } from "../src/dashboard/lectura.ts";
import { construirVistaPreviaImportacion, MAX_MOVIMIENTOS_CONCILIACION } from "../src/conciliacion/estado-de-cuenta/previsualizacion.ts";
import { parsearEstadoDeCuenta } from "../src/conciliacion/estado-de-cuenta/index.ts";
import type { RegistroConciliable } from "../src/conciliacion/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ENC = "Fecha,Descripción,Cargo,Abono\n";
const registros: RegistroConciliable[] = [
  { id: "inv-1", fecha: "2026-01-05", total: 1160, descripcion: "CLIENTE ACME", referencia: "F-1", folioFiscal: "uuid-1" },
  { id: "inv-2", fecha: "2026-01-06", total: 500, descripcion: "OTRO", referencia: "F-2", folioFiscal: "uuid-2" },
  { id: "inv-3", fecha: "2026-01-07", total: 300, descripcion: "TERCERO", referencia: "F-3", folioFiscal: "uuid-3" },
];

describe("construirVistaPreviaImportacion", () => {
  it("concilia con el motor existente y sugiere la cuenta por cobrar solo para abonos", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "05/01/2026,SPEI ACME,,1160.00\n06/01/2026,PAGO PROVEEDOR OTRO,500.00,\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({
      parseo,
      registros,
      cuentasPorCobrarPendientes: [
        { id: "cxc-1", invoiceId: "inv-1" },
        { id: "cxc-2", invoiceId: "inv-2" },
      ],
    });
    expect(v.conciliacion?.totalMatched).toBe(2);
    const abono = v.coincidencias.find((c) => c.registroIds[0] === "inv-1")!;
    const cargo = v.coincidencias.find((c) => c.registroIds[0] === "inv-2")!;
    expect(abono.cobranzaPendienteIds).toEqual(["cxc-1"]);
    expect(abono.hash).toBe(parseo.movimientos[0]!.hash);
    expect(abono.folioFiscal).toEqual(["uuid-1"]);
    // Un cargo (salida de dinero) nunca sugiere cobrar una factura emitida.
    expect(cargo.cobranzaPendienteIds).toEqual([]);
    expect(v.cobranzaDisponible).toBe(true);
    expect(v.libroDisponible).toBe(false); // sin información del libro
  });

  it("nivel 3: un abono que cubre varias facturas lista todos los CFDI y sus cuentas", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "06/01/2026,PAGO VARIAS FACTURAS,,800.00\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: [{ id: "cxc-2", invoiceId: "inv-2" }, { id: "cxc-3", invoiceId: "inv-3" }] });
    const multi = v.coincidencias.find((c) => c.nivel === "multi_linea");
    expect([...(multi?.registroIds ?? [])].sort()).toEqual(["inv-2", "inv-3"]);
    expect([...(multi?.cobranzaPendienteIds ?? [])].sort()).toEqual(["cxc-2", "cxc-3"]);
  });

  it("movimientos ya importados (hash conocido) no se vuelven a conciliar ni cuentan como nuevos", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "05/01/2026,SPEI ACME,,1160.00\n06/01/2026,PAGO PROVEEDOR OTRO,500.00,\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: [], hashesYaImportados: new Set([parseo.movimientos[0]!.hash]) });
    expect(v.libroDisponible).toBe(true);
    expect(v.yaImportados).toEqual([parseo.movimientos[0]!.hash]);
    expect(v.nuevos).toBe(1);
    expect(v.conciliacion?.totalMovements).toBe(1);
    expect(v.coincidencias.map((c) => c.registroIds[0])).toEqual(["inv-2"]);
  });

  it("libro no disponible (null): se declara y se trata todo como nuevo, sin inventar duplicados", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "05/01/2026,SPEI ACME,,1160.00\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: [], hashesYaImportados: null });
    expect(v.libroDisponible).toBe(false);
    expect(v.nuevos).toBe(1);
    expect(v.yaImportados).toEqual([]);
  });

  it("todo ya importado: se explica, no se corre el motor", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "05/01/2026,SPEI ACME,,1160.00\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: [], hashesYaImportados: new Set(parseo.movimientos.map((m) => m.hash)) });
    expect(v.conciliacion).toBeNull();
    expect(v.conciliacionOmitida).toContain("ya se habían importado");
  });

  it("por encima del tope no concilia y lo dice (nunca en silencio)", () => {
    const filas = Array.from({ length: MAX_MOVIMIENTOS_CONCILIACION + 1 }, (_, i) => `05/01/2026,MOV ${i},,${i + 1}.00`);
    const parseo = parsearEstadoDeCuenta(ENC + filas.join("\n"), { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: [] });
    expect(v.conciliacion).toBeNull();
    expect(v.conciliacionOmitida).toContain(String(MAX_MOVIMIENTOS_CONCILIACION));
    expect(v.nuevos).toBe(MAX_MOVIMIENTOS_CONCILIACION + 1);
  });

  it("cobranza no disponible (null): la conciliación sigue y se declara honestamente", () => {
    const parseo = parsearEstadoDeCuenta(ENC + "05/01/2026,SPEI ACME,,1160.00\n", { cuenta: "C" });
    const v = construirVistaPreviaImportacion({ parseo, registros, cuentasPorCobrarPendientes: null });
    expect(v.cobranzaDisponible).toBe(false);
    expect(v.coincidencias).toHaveLength(1);
    expect(v.coincidencias[0]!.cobranzaPendienteIds).toEqual([]);
  });
});

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("lectura de cobranza para la vista previa -- base sin migrar (REGLA DURA)", () => {
  it("tabla receivable inexistente (42P01): devuelve null y la sesión abortada se recupera con SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.receivable\b/i, respond: () => pgError("42P01", 'relation "despachos.receivable" does not exist') }]);
    const repo = new PostgresDespachosRepository(session);

    const cartera = await leerFuenteOpcional(repo, () => repo.listReceivables("prop-1", { pendiente: true }));

    expect(cartera).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // La transacción del request sigue utilizable (sin SAVEPOINT aquí caería 25P02 y el COMMIT sería ROLLBACK).
    await expect(session.query("select 1;")).rejects.not.toMatchObject({ code: "25P02" });
  });

  it("otro error de Postgres (statement_timeout 57014) se repropaga, no se enmascara como 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /from despachos\.receivable\b/i, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    const repo = new PostgresDespachosRepository(session);
    await expect(leerFuenteOpcional(repo, () => repo.listReceivables("prop-1", { pendiente: true }))).rejects.toMatchObject({ code: "57014" });
  });
});
