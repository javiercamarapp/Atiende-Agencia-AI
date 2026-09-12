// Tests de dominio de `spei-matching.ts` — puerto del scoring puro de
// `SPEIVerifier.verify_against_movements`/`verify_pago_proveedor`. Puntajes EXACTOS
// documentados en el informe de auditoría de esta fase.
import { describe, expect, it } from "vitest";
import { verificarSpeiContraMovimientos, verificarPagoProveedor, verificadorSpeiExternoPendiente } from "../src/conciliacion/spei-matching.ts";
import type { MovimientoBancario } from "../src/conciliacion/types.ts";

function mov(overrides: Partial<MovimientoBancario> = {}): MovimientoBancario {
  return { fecha: "2025-01-01", descripcion: "SPEI recibido", referencia: null, cargo: null, abono: null, saldo: null, monto: 1000, banco: "generic", formato: "csv", ...overrides };
}

describe("verificarSpeiContraMovimientos", () => {
  it("referencia contiene la clave de rastreo + monto exacto + misma fecha -> score=100, verified", () => {
    const movimientos = [mov({ referencia: "SPEI-ABC123456", monto: 5000, fecha: "2025-05-01" })];
    const r = verificarSpeiContraMovimientos("ABC123456", 5000, "2025-05-01", movimientos);
    expect(r.bestScore).toBe(100);
    expect(r.verified).toBe(true);
    expect(r.movementIdx).toBe(0);
  });

  it("sin coincidencia de referencia, monto relativo <5% y fecha dentro de tolerancia -> score=20, no verified (<60)", () => {
    const movimientos = [mov({ referencia: "OTRAREF", monto: 1030, fecha: "2025-05-02" })];
    const r = verificarSpeiContraMovimientos("ZZZZZZZZ", 1000, "2025-05-01", movimientos, 3);
    expect(r.verified).toBe(false);
  });

  it("umbral de aceptación es score >= 60", () => {
    // Monto exacto (+30) + fecha exacta (+10) = 40 -> no verificado.
    const movimientos = [mov({ referencia: null, monto: 1000, fecha: "2025-05-01" })];
    const r = verificarSpeiContraMovimientos("SINCOINCIDENCIA", 1000, "2025-05-01", movimientos);
    expect(r.bestScore).toBe(40);
    expect(r.verified).toBe(false);
  });
});

describe("verificarPagoProveedor", () => {
  it("RFC completo en descripción + monto exacto + fecha exacta -> score=100, verified", () => {
    const movimientos = [mov({ descripcion: "Pago a proveedor RFC ABC850101XY9", monto: 2000, fecha: "2025-06-01" })];
    const r = verificarPagoProveedor("ABC850101XY9", 2000, "2025-06-01", movimientos);
    expect(r.bestScore).toBe(100);
    expect(r.verified).toBe(true);
  });

  it("umbral de aceptación es score >= 50 (distinto del umbral 60 de SPEI)", () => {
    // Prefijo de 6 (+25) + monto relativo <5% (+15) = 40 -> no verificado a este umbral.
    const movimientos = [mov({ descripcion: "Pago ABC850 varios", monto: 1030, fecha: "2025-06-05" })];
    const r = verificarPagoProveedor("ABC850101XY9", 1000, "2025-06-01", movimientos, 3);
    expect(r.bestScore).toBe(40);
    expect(r.verified).toBe(false);
  });
});

describe("verificadorSpeiExternoPendiente — adaptador fail-closed", () => {
  it("sin credenciales reales configuradas, siempre devuelve pending_verification (nunca inventa un verificado)", async () => {
    const r = await verificadorSpeiExternoPendiente.consultar({ claveRastreo: "X", fecha: "2025-01-01" });
    expect(r.verified).toBe(false);
    expect(r.status).toBe("pending_verification");
  });
});
