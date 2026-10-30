// IMSS por rama 2026 (tasas por validar con fiscalista). Valores esperados calculados a mano:
// base = SBC × 30 días; cuota fija patronal = 20.40 % × UMA diaria (117.31 desde feb-2026) × 30.
import { describe, expect, it } from "vitest";
import { ImssInvalidoError, calcularImssPorRama } from "../src/nomina/imss-engine.ts";
import { CEAV_PATRONAL_2026, tasaCeavPatronal } from "../src/nomina/parametros.ts";

const F = "2026-02-28";
const imss = (sbcDiario: number, extra: Partial<Parameters<typeof calcularImssPorRama>[0]> = {}) => calcularImssPorRama({ sbcDiario, diasPagados: 30, fechaPago: F, ...extra });

describe("IMSS por rama", () => {
  it("SBC bajo (140): sin excedente de 3 UMA", () => {
    const r = imss(140);
    expect(r.obrero).toEqual({ eymExcedente: 0, prestacionesDinero: 10.5, gmp: 15.75, invalidezVida: 26.25, ceav: 47.25, total: 99.75 });
    expect(r.patronal.cuotaFija).toBe(717.94);
    expect(r.patronal.eymExcedente).toBe(0);
    expect(r.patronal.retiro).toBe(84);
    expect(r.patronal.guarderias).toBe(42);
    expect(r.infonavit).toBe(210);
  });

  it("SBC medio (500): excedente sobre 3 UMA y CEAV progresiva 7.513 % (4.26 UMA)", () => {
    const r = imss(500);
    expect(r.obrero.eymExcedente).toBe(17.77); // (500 − 351.93) × 30 × 0.4 %
    expect(r.obrero.total).toBe(374.02);
    expect(r.patronal.eymExcedente).toBe(48.86); // × 1.10 %
    expect(r.patronal.ceav).toBe(1126.95); // 15,000 × 7.513 %
    expect(r.infonavit).toBe(750);
  });

  it("SBC en el tope (25 UMA = 2,932.75): se topa y se avisa", () => {
    const r = imss(3000);
    expect(r.sbcDiario).toBe(2932.75);
    expect(r.sbcTopado).toBe(true);
    expect(r.obrero.total).toBe(2399.28);
    expect(r.patronal.total).toBe(14376.84);
  });

  it("SBC exactamente en el tope no se marca como topado", () => {
    expect(imss(2932.75).sbcTopado).toBe(false);
  });

  it("la UMA de enero (113.14) cambia la cuota fija y el tope", () => {
    const ene = imss(140, { fechaPago: "2026-01-31" });
    expect(ene.umaDiaria).toBe(113.14);
    expect(ene.patronal.cuotaFija).toBe(692.42);
  });

  it("la prima RT es parámetro de la empresa: clase I por omisión y 2.5 % si se indica", () => {
    expect(imss(500).patronal.riesgoTrabajo).toBe(81.53);
    expect(imss(500, { primaRt: 0.025 }).patronal.riesgoTrabajo).toBe(375);
  });

  it("rechaza SBC <= 0, días <= 0 y prima RT fuera de rango (antes daba IMSS 0 o negativo sin aviso)", () => {
    expect(() => imss(0)).toThrow(ImssInvalidoError);
    expect(() => imss(-100)).toThrow(ImssInvalidoError);
    expect(() => imss(500, { diasPagados: 0 })).toThrow(ImssInvalidoError);
    expect(() => imss(500, { primaRt: 0.5 })).toThrow(ImssInvalidoError);
  });

  it("la tabla CEAV es monótona creciente y asigna el tramo por UMA", () => {
    for (let i = 1; i < CEAV_PATRONAL_2026.length; i++) expect(CEAV_PATRONAL_2026[i]!.tasa).toBeGreaterThan(CEAV_PATRONAL_2026[i - 1]!.tasa);
    expect(tasaCeavPatronal(1.2)).toBe(0.03676);
    expect(tasaCeavPatronal(4.0)).toBe(0.06613);
    expect(tasaCeavPatronal(4.01)).toBe(0.07513);
  });
});
