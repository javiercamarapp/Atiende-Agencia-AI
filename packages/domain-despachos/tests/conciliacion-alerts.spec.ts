// Tests de dominio de `alerts.ts` — puerto de `AlertEngine` (reconciliation_agent).
// Verifica los umbrales/reglas EXACTOS documentados en el informe de auditoría de
// esta fase: buckets de antigüedad, colapso a warning/critical en depósitos/retiros
// sin CFDI, escalamiento duplicado a los 30 días, ventana de duplicados de 1 día.
import { describe, expect, it } from "vitest";
import { revisarMovimiento, revisarDuplicados, revisarDiscrepanciaIngresos, severidadPorAntiguedad, UMBRAL_MOVIMIENTO_GRANDE } from "../src/conciliacion/alerts.ts";
import type { MovimientoBancario } from "../src/conciliacion/types.ts";

function mov(overrides: Partial<MovimientoBancario> = {}): MovimientoBancario {
  return { fecha: "2025-01-01", descripcion: "Movimiento genérico", referencia: null, cargo: null, abono: null, saldo: null, monto: 100, banco: "generic", formato: "csv", ...overrides };
}

describe("severidadPorAntiguedad — buckets exactos", () => {
  it.each([
    [0, "info"],
    [7, "info"],
    [8, "info"],
    [15, "info"],
    [16, "warning"],
    [30, "warning"],
    [31, "warning"],
    [60, "warning"],
    [61, "critical"],
    [999, "critical"],
    [5000, "critical"],
  ] as const)("días=%i -> %s", (dias, esperado) => {
    expect(severidadPorAntiguedad(dias)).toBe(esperado);
  });
});

describe("revisarMovimiento", () => {
  const hoy = new Date("2025-02-01T00:00:00Z");

  it("comisión bancaria -> info, corta ejecución (una sola alerta)", () => {
    const alertas = revisarMovimiento(mov({ descripcion: "Cargo por comisión de manejo", monto: -50, fecha: "2025-01-30" }), UMBRAL_MOVIMIENTO_GRANDE, hoy);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.rule).toBe("bank_fee");
    expect(alertas[0]!.severity).toBe("info");
  });

  it("transferencia entre cuentas propias -> info, corta ejecución", () => {
    const alertas = revisarMovimiento(mov({ descripcion: "Traspaso entre cuentas propias" }), UMBRAL_MOVIMIENTO_GRANDE, hoy);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]!.rule).toBe("own_account_transfer");
  });

  it("depósito sin CFDI a 10 días -> severidad colapsa a warning (nunca info)", () => {
    const alertas = revisarMovimiento(mov({ monto: 500, fecha: "2025-01-22", descripcion: "Depósito varios" }), UMBRAL_MOVIMIENTO_GRANDE, hoy);
    const depAlert = alertas.find((a) => a.rule === "deposit_no_cfdi")!;
    expect(depAlert.severity).toBe("warning");
  });

  it("retiro sin CFDI a 65 días -> deposit/withdrawal critical + aging_escalation critical (dos alertas critical)", () => {
    const alertas = revisarMovimiento(mov({ monto: -300, fecha: "2024-11-28", descripcion: "Retiro varios" }), UMBRAL_MOVIMIENTO_GRANDE, hoy);
    const criticals = alertas.filter((a) => a.severity === "critical");
    expect(criticals.length).toBeGreaterThanOrEqual(2);
    expect(alertas.some((a) => a.rule === "withdrawal_no_cfdi")).toBe(true);
    expect(alertas.some((a) => a.rule === "aging_escalation")).toBe(true);
  });

  it("movimiento grande no identificado (>= 50,000) -> alerta critical adicional", () => {
    const alertas = revisarMovimiento(mov({ monto: 60000, fecha: "2025-01-31" }), UMBRAL_MOVIMIENTO_GRANDE, hoy);
    expect(alertas.some((a) => a.rule === "large_unidentified_movement")).toBe(true);
  });
});

describe("revisarDuplicados", () => {
  it("mismo monto+descripción, 1 día de diferencia -> duplicado", () => {
    const movimientos = [mov({ monto: -200, descripcion: "Pago proveedor XYZ", fecha: "2025-01-01" }), mov({ monto: -200, descripcion: "Pago proveedor XYZ", fecha: "2025-01-02" })];
    const alertas = revisarDuplicados(movimientos);
    expect(alertas).toHaveLength(2);
    expect(alertas.every((a) => a.rule === "duplicate_payment")).toBe(true);
  });

  it("mismo monto+descripción, 3 días de diferencia -> NO duplicado", () => {
    const movimientos = [mov({ monto: -200, descripcion: "Pago proveedor XYZ", fecha: "2025-01-01" }), mov({ monto: -200, descripcion: "Pago proveedor XYZ", fecha: "2025-01-04" })];
    expect(revisarDuplicados(movimientos)).toHaveLength(0);
  });

  it("montos distintos -> nunca duplicado", () => {
    const movimientos = [mov({ monto: -200, fecha: "2025-01-01" }), mov({ monto: -201, fecha: "2025-01-01" })];
    expect(revisarDuplicados(movimientos)).toHaveLength(0);
  });
});

describe("revisarDiscrepanciaIngresos", () => {
  it("declaredIncome<=0 -> null (sin base de comparación)", () => {
    expect(revisarDiscrepanciaIngresos(1000, 0)).toBeNull();
    expect(revisarDiscrepanciaIngresos(1000, -5)).toBeNull();
  });

  it("ratio <= 1.15 -> sin alerta", () => {
    expect(revisarDiscrepanciaIngresos(1150, 1000)).toBeNull();
  });

  it("ratio > 1.15 -> alerta critical Art. 91 LISR", () => {
    const alerta = revisarDiscrepanciaIngresos(1200, 1000);
    expect(alerta).not.toBeNull();
    expect(alerta!.severity).toBe("critical");
    expect(alerta!.rule).toBe("income_discrepancy_art91");
  });
});
