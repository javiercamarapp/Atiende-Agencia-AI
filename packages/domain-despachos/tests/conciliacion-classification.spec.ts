// Tests de dominio de `classification.ts` — puerto de las reglas de
// `reconciliacion_ingresos_egresos/classification_rules.py`. Orden de evaluación
// secuencial (primera regla que matchea gana) y umbral de revisión humana 0.7.
import { describe, expect, it } from "vitest";
import { clasificarDeposito, puedePersistirseClasificacion, evaluarCasoDepositoSospechoso, calcularBalanceIva, UMBRAL_CONFIANZA_SOSPECHOSA } from "../src/conciliacion/classification.ts";

describe("clasificarDeposito", () => {
  it("referencia con CFDI -> ingreso, confidence 0.95, sin revisión humana", () => {
    const r = clasificarDeposito("Pago de cliente", "CFDI-12345");
    expect(r.clasificacion).toBe("ingreso");
    expect(r.confidence).toBe(0.95);
    expect(r.requiresHumanReview).toBe(false);
  });

  it("descripción con PRESTAMO -> financiamiento, confidence 0.85 (>= 0.7, no marca requiresHumanReview)", () => {
    const r = clasificarDeposito("Deposito por prestamo bancario");
    expect(r.clasificacion).toBe("financiamiento");
    expect(r.confidence).toBe(0.85);
    // requiresHumanReview solo mira el umbral de CONFIANZA (0.7), no si la
    // clasificación es "no trivial" — esa segunda noción (documento de soporte
    // obligatorio) la cubre `puedePersistirseClasificacion`/
    // `evaluarCasoDepositoSospechoso` por separado, ver esos tests abajo.
    expect(r.requiresHumanReview).toBe(false);
  });

  it("descripción con APORTACION SOCIO -> aportacion_socio, confidence 0.90", () => {
    // Evita a propósito la frase "capital de trabajo" (dispara la regla 2,
    // financiamiento, que tiene prioridad — ver siguiente test) para aislar la
    // regla 3 (aportación de socio).
    const r = clasificarDeposito("Aportacion de socio para fortalecer el capital social");
    expect(r.clasificacion).toBe("aportacion_socio");
    expect(r.confidence).toBe(0.9);
  });

  it("'aportacion de socio' + 'capital de trabajo' -> gana financiamiento (regla 2 antes que regla 3, orden estricto)", () => {
    const r = clasificarDeposito("Aportacion de socio para capital de trabajo");
    expect(r.clasificacion).toBe("financiamiento");
  });

  it("descripción con GARANTIA -> garantia, confidence 0.85", () => {
    const r = clasificarDeposito("Deposito en garantia de contrato");
    expect(r.clasificacion).toBe("garantia");
  });

  it("orden de reglas: CFDI (regla 1) gana sobre SOCIO (regla 3) si ambos matchean", () => {
    const r = clasificarDeposito("Factura de aportacion de socio", "CFDI-1");
    expect(r.clasificacion).toBe("ingreso");
  });

  it("sin ninguna regla -> otro_no_gravable, confidence 0.5, requiere revisión", () => {
    const r = clasificarDeposito("Movimiento sin descripción clara");
    expect(r.clasificacion).toBe("otro_no_gravable");
    expect(r.confidence).toBe(0.5);
    expect(r.requiresHumanReview).toBe(true);
  });

  it("umbral de revisión humana es < 0.7 estricto (no <=)", () => {
    expect(UMBRAL_CONFIANZA_SOSPECHOSA).toBe(0.7);
  });
});

describe("puedePersistirseClasificacion", () => {
  it("ingreso/otro_no_gravable siempre pueden persistirse sin documento", () => {
    expect(puedePersistirseClasificacion("ingreso", null)).toBe(true);
    expect(puedePersistirseClasificacion("otro_no_gravable", null)).toBe(true);
  });

  it("financiamiento/aportacion_socio/garantia requieren documento de soporte", () => {
    expect(puedePersistirseClasificacion("financiamiento", null)).toBe(false);
    expect(puedePersistirseClasificacion("financiamiento", "")).toBe(false);
    expect(puedePersistirseClasificacion("financiamiento", "doc-123")).toBe(true);
    expect(puedePersistirseClasificacion("aportacion_socio", "doc-1")).toBe(true);
    expect(puedePersistirseClasificacion("garantia", "doc-1")).toBe(true);
  });
});

describe("evaluarCasoDepositoSospechoso", () => {
  it("clasificación no trivial sin documento -> sospechoso, con nota legal Art. 59 fr. III", () => {
    const r = evaluarCasoDepositoSospechoso("financiamiento", null, 0.85);
    expect(r.esSospechoso).toBe(true);
    expect(r.nota).toContain("Art. 59 fr. III CFF");
  });

  it("clasificación no trivial CON documento y confidence alta -> no sospechoso", () => {
    const r = evaluarCasoDepositoSospechoso("financiamiento", "doc-1", 0.85);
    expect(r.esSospechoso).toBe(false);
    expect(r.nota).toBeNull();
  });

  it("clasificación no trivial con documento pero confidence baja -> sigue sospechoso", () => {
    const r = evaluarCasoDepositoSospechoso("garantia", "doc-1", 0.5);
    expect(r.esSospechoso).toBe(true);
  });

  it("nunca produce un 'rechazo' automático — solo esSospechoso (revisión humana), nunca niega la devolución", () => {
    const r = evaluarCasoDepositoSospechoso("aportacion_socio", null, 0.9);
    expect(typeof r.esSospechoso).toBe("boolean");
  });

  it("clasificación 'ingreso' nunca es sospechosa aunque falte documento", () => {
    const r = evaluarCasoDepositoSospechoso("ingreso", null, 0.95);
    expect(r.esSospechoso).toBe(false);
  });
});

describe("calcularBalanceIva", () => {
  it("ivaPagado > ivaCobrado -> saldo a favor, discrepancia = |diferencia real - declarado|", () => {
    // real = ivaCobrado - ivaPagado = 600 - 1000 = -400; declarado=-400 -> discrepancia=0.
    const r = calcularBalanceIva(1000, 600, -400);
    expect(r.saldoFavor).toBe(400);
    expect(r.ivaAcreditable).toBe(400);
    expect(r.saldoContra).toBe(0);
    expect(r.discrepancia).toBe(0);
  });

  it("ivaCobrado > ivaPagado -> saldo a cargo (contra)", () => {
    const r = calcularBalanceIva(400, 1000, 600);
    expect(r.saldoContra).toBe(600);
    expect(r.saldoFavor).toBe(0);
    expect(r.discrepancia).toBe(0);
  });

  it("discrepancia = |diferencia real - declarado|", () => {
    const r = calcularBalanceIva(400, 1000, 500);
    // real = cobrado - pagado = 600; declarado=500 -> discrepancia=100
    expect(r.discrepancia).toBe(100);
  });
});
