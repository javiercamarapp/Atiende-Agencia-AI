// Fase 6 hoteles (REQ-REV-013) — unidad de la capa pura de night-audit
// (night-audit/engine.ts): qué reservas en casa generan cargo de hospedaje, qué
// anomalías se reportan (folio-cero / sin-tarifa, nunca silenciadas ni inventadas),
// qué no-shows generan penalización, y el planificador de fecha de negocio/hora
// local (port de nightAuditScheduler.ts::businessDateToClose/localHour).
import { describe, expect, it } from "vitest";
import {
  businessDateToClose,
  buildNightAuditSummary,
  DEFAULT_PROPERTY_TIMEZONE,
  isPastNightAuditRunHour,
  localHour,
  planNightlyHospedajeCharges,
  type InHouseReservationForNightAudit,
} from "../src/night-audit/engine.ts";
import type { TaxConfig } from "../src/taxes.ts";

const TAX_CONFIG: TaxConfig = { ivaRate: 0.16, ishRate: 0.03 };

describe("planNightlyHospedajeCharges", () => {
  it("postea el cargo de hospedaje (neto + IVA + ISH) de cada reserva en casa con folio y tarifa", () => {
    const reservations: InHouseReservationForNightAudit[] = [{ reservationId: "r1", folioId: "f1", nightlyPrice: 1000 }];
    const plan = planNightlyHospedajeCharges(reservations, TAX_CONFIG);
    expect(plan.anomalies).toEqual([]);
    expect(plan.charges).toHaveLength(1);
    expect(plan.charges[0]).toMatchObject({ reservationId: "r1", folioId: "f1", netAmount: 1000 });
    // IVA 16% + ISH 3% sobre 1000 = 190.
    expect(plan.charges[0]!.taxAmount).toBeCloseTo(190, 2);
  });

  it("reporta folio-cero como anomalía (NUNCA inventa un folio) y no postea nada para esa reserva", () => {
    const reservations: InHouseReservationForNightAudit[] = [{ reservationId: "r1", folioId: null, nightlyPrice: 1000 }];
    const plan = planNightlyHospedajeCharges(reservations, TAX_CONFIG);
    expect(plan.charges).toEqual([]);
    expect(plan.anomalies).toHaveLength(1);
    expect(plan.anomalies[0]).toMatchObject({ reservationId: "r1", type: "folio_cero" });
  });

  it("reporta sin-tarifa como anomalía (NUNCA postea $0 inventado) y no postea nada para esa reserva", () => {
    const reservations: InHouseReservationForNightAudit[] = [{ reservationId: "r1", folioId: "f1", nightlyPrice: null }];
    const plan = planNightlyHospedajeCharges(reservations, TAX_CONFIG);
    expect(plan.charges).toEqual([]);
    expect(plan.anomalies).toHaveLength(1);
    expect(plan.anomalies[0]).toMatchObject({ reservationId: "r1", type: "sin_tarifa" });
  });

  it("varias reservas se evalúan de forma independiente: una anomalía no contamina el resto", () => {
    const reservations: InHouseReservationForNightAudit[] = [
      { reservationId: "ok", folioId: "f1", nightlyPrice: 1000 },
      { reservationId: "sin-folio", folioId: null, nightlyPrice: 1000 },
      { reservationId: "sin-tarifa", folioId: "f2", nightlyPrice: null },
    ];
    const plan = planNightlyHospedajeCharges(reservations, TAX_CONFIG);
    expect(plan.charges.map((c) => c.reservationId)).toEqual(["ok"]);
    expect(plan.anomalies.map((a) => a.reservationId).sort()).toEqual(["sin-folio", "sin-tarifa"]);
  });
});

describe("buildNightAuditSummary", () => {
  it("arma el resumen con conciliación A&B/POS SIEMPRE 'sin_pos_configurado' (ADR-007, nunca simulada)", () => {
    const summary = buildNightAuditSummary({
      businessDate: "2026-09-10",
      propertyId: "p1",
      postedCharges: [],
      noShows: [],
      anomalies: [],
      cargosPorConcepto: {},
      pagosPorMetodo: {},
      enCasa: 3,
    });
    expect(summary.conciliacionAB).toEqual({ estado: "sin_pos_configurado" });
    expect(summary.ocupacion).toEqual({ enCasa: 3 });
    expect(summary.yaCompletado).toBe(false);
  });
});

describe("businessDateToClose / localHour / isPastNightAuditRunHour", () => {
  it("cierra SIEMPRE el día anterior al 'hoy' en la zona horaria dada", () => {
    // 2026-09-10T02:00:00-06:00 (madrugada CDMX) == 2026-09-10T08:00:00Z.
    const now = new Date("2026-09-10T08:00:00Z");
    expect(businessDateToClose(now, DEFAULT_PROPERTY_TIMEZONE)).toBe("2026-09-09");
  });

  it("localHour refleja la hora de reloj local, no la hora UTC", () => {
    const now = new Date("2026-09-10T08:00:00Z"); // 02:00 hora CDMX (UTC-6).
    expect(localHour(now, DEFAULT_PROPERTY_TIMEZONE)).toBe(2);
  });

  it("isPastNightAuditRunHour respeta el umbral configurable (default 03:00 hora local)", () => {
    const antesDeLasTres = new Date("2026-09-10T08:00:00Z"); // 02:00 CDMX
    const despuesDeLasTres = new Date("2026-09-10T10:00:00Z"); // 04:00 CDMX
    expect(isPastNightAuditRunHour(antesDeLasTres, DEFAULT_PROPERTY_TIMEZONE)).toBe(false);
    expect(isPastNightAuditRunHour(despuesDeLasTres, DEFAULT_PROPERTY_TIMEZONE)).toBe(true);
  });
});
