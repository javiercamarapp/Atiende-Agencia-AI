// Tests de dominio de `verificacion.ts` — tolerancias EXACTAS REQ-MIG-012/013/
// 014/015.
import { describe, expect, it } from "vitest";
import {
  verificarConteoPolizas,
  detectarDiscrepanciasBalancePorPoliza,
  calcularSaldoCuentaPeriodo,
  detectarDiscrepanciasCuadreSaldos,
  detectarReferenciasHuerfanas,
  cerrarMigracion,
  TOLERANCIA_CUADRE_MXN_DEFAULT,
} from "../src/migracion-catalogo/verificacion.ts";
import { DiscrepanciaConteoPolizasError } from "../src/migracion-catalogo/types.ts";

describe("verificarConteoPolizas — tolerancia 0", () => {
  it("conteos iguales -> no lanza", () => {
    expect(() => verificarConteoPolizas(10, 10)).not.toThrow();
  });
  it("cualquier diferencia, en cualquier dirección -> lanza", () => {
    expect(() => verificarConteoPolizas(10, 9)).toThrow(DiscrepanciaConteoPolizasError);
    expect(() => verificarConteoPolizas(9, 10)).toThrow(DiscrepanciaConteoPolizasError);
  });
});

describe("detectarDiscrepanciasBalancePorPoliza — tolerancia 0 exacta", () => {
  it("póliza balanceada -> sin discrepancias", () => {
    const lineas = [
      { polizaOrigenId: "p1", cuentaDestinoId: "d1", debe: 1000, haber: 0 },
      { polizaOrigenId: "p1", cuentaDestinoId: "d2", debe: 0, haber: 1000 },
    ];
    expect(detectarDiscrepanciasBalancePorPoliza(lineas)).toHaveLength(0);
  });

  it("desbalance de 0.01 (no 0) -> SÍ es discrepancia (tolerancia estricta 0, distinta de la de cuadre de saldos)", () => {
    const lineas = [
      { polizaOrigenId: "p1", cuentaDestinoId: "d1", debe: 1000, haber: 0 },
      { polizaOrigenId: "p1", cuentaDestinoId: "d2", debe: 0, haber: 999.99 },
    ];
    const discrepancias = detectarDiscrepanciasBalancePorPoliza(lineas);
    expect(discrepancias).toHaveLength(1);
    expect(discrepancias[0]!.diferencia).toBeCloseTo(0.01);
  });

  it("conjunto vacío -> cuadra vacuamente", () => {
    expect(detectarDiscrepanciasBalancePorPoliza([])).toHaveLength(0);
  });
});

describe("calcularSaldoCuentaPeriodo", () => {
  const asientos = [
    { cuentaDebito: "c1", cuentaCredito: "c2", monto: 500 },
    { cuentaDebito: "c3", cuentaCredito: "c1", monto: 200 },
  ];

  it("naturaleza deudora (D u otro) -> debito - credito", () => {
    // c1: debito=500 (primer asiento), credito=200 (segundo asiento) -> 500-200=300
    expect(calcularSaldoCuentaPeriodo(asientos, "c1", "D")).toBe(300);
  });

  it("naturaleza acreedora (A) -> credito - debito", () => {
    // c1 con naturaleza A: credito(200) - debito(500) = -300
    expect(calcularSaldoCuentaPeriodo(asientos, "c1", "A")).toBe(-300);
  });
});

describe("detectarDiscrepanciasCuadreSaldos — tolerancia 0.01, estrictamente > (== cuadra)", () => {
  it("diferencia exactamente igual a la tolerancia -> SÍ cuadra (no es discrepancia)", () => {
    const pares = [{ cuentaOrigenId: "o1", cuentaDestinoId: "d1", saldoOrigenPeriodo: 100, saldoDestinoPeriodo: 100.01 }];
    expect(detectarDiscrepanciasCuadreSaldos(pares, TOLERANCIA_CUADRE_MXN_DEFAULT)).toHaveLength(0);
  });

  it("diferencia mayor a la tolerancia -> discrepancia", () => {
    const pares = [{ cuentaOrigenId: "o1", cuentaDestinoId: "d1", saldoOrigenPeriodo: 100, saldoDestinoPeriodo: 100.02 }];
    expect(detectarDiscrepanciasCuadreSaldos(pares, TOLERANCIA_CUADRE_MXN_DEFAULT)).toHaveLength(1);
  });
});

describe("detectarReferenciasHuerfanas", () => {
  it("línea cuya cuenta destino no existe -> huérfana", () => {
    const lineas = [
      { polizaOrigenId: "p1", cuentaDestinoId: "existe", debe: 100, haber: 0 },
      { polizaOrigenId: "p1", cuentaDestinoId: "no-existe", debe: 0, haber: 100 },
    ];
    const huerfanas = detectarReferenciasHuerfanas(lineas, new Set(["existe"]));
    expect(huerfanas).toHaveLength(1);
    expect(huerfanas[0]!.cuentaDestinoId).toBe("no-existe");
  });
});

describe("cerrarMigracion — orquesta las 4 verificaciones, lanza en la primera que falle", () => {
  it("todo cuadra -> no lanza", () => {
    expect(() =>
      cerrarMigracion({
        countOrigenElegibles: 1,
        countDestinoMigradas: 1,
        lineasMigradas: [{ polizaOrigenId: "p1", cuentaDestinoId: "d1", debe: 100, haber: 100 }],
        paresCuadreSaldo: [],
        cuentasDestinoExistentesIds: new Set(["d1"]),
      }),
    ).not.toThrow();
  });

  it("conteo de pólizas falla primero -> DiscrepanciaConteoPolizasError", () => {
    expect(() =>
      cerrarMigracion({
        countOrigenElegibles: 2,
        countDestinoMigradas: 1,
        lineasMigradas: [],
        paresCuadreSaldo: [],
        cuentasDestinoExistentesIds: new Set(),
      }),
    ).toThrow(DiscrepanciaConteoPolizasError);
  });
});
