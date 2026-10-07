// QA R2 automatizacion-02/08/11: dia de negocio por corte. Misma regla que restaurantes.dia_negocio (migracion 076; la prueba contra Postgres real
// vive en scripts/verify-restaurantes-qa-r2-automatizacion-caos).
import { describe, expect, it } from "vitest";
import { corteDiaNegocioMinutos, diaDeNegocio } from "../src/horarios.ts";

const PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] as const;
const DIURNO = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "09:00", cierra: "22:00" }] as const;

describe("corteDiaNegocioMinutos", () => {
  it("PM (12:00-01:00) cierra 60 min despues de medianoche; sin horario o sin turno que cruce es 0", () => {
    expect(corteDiaNegocioMinutos(PM)).toBe(60);
    expect(corteDiaNegocioMinutos(DIURNO)).toBe(0);
    expect(corteDiaNegocioMinutos(null)).toBe(0);
    expect(corteDiaNegocioMinutos([])).toBe(0);
  });
  it("con doble turno toma el cierre mas tardio despues de medianoche", () => {
    expect(corteDiaNegocioMinutos([{ dias: [5, 6], abre: "12:00", cierra: "16:00" }, { dias: [5, 6], abre: "18:00", cierra: "02:30" }])).toBe(150);
  });
});

describe("diaDeNegocio", () => {
  it("a las 00:30 del domingo (06:30Z en Merida) todavia es el dia de negocio del sabado; a la 01:10 ya es domingo", () => {
    expect(diaDeNegocio(new Date("2026-10-11T06:30:00Z"), "America/Merida", PM)).toBe("2026-10-10");
    expect(diaDeNegocio(new Date("2026-10-11T07:10:00Z"), "America/Merida", PM)).toBe("2026-10-11");
  });
  it("en Cancun (UTC-5) el mismo corte aplica a su hora local", () => {
    expect(diaDeNegocio(new Date("2026-10-11T05:05:00Z"), "America/Cancun", PM)).toBe("2026-10-10");
    expect(diaDeNegocio(new Date("2026-10-11T06:05:00Z"), "America/Cancun", PM)).toBe("2026-10-11");
  });
  it("sin turnos que crucen la medianoche es el dia calendario", () => {
    expect(diaDeNegocio(new Date("2026-10-11T06:30:00Z"), "America/Merida", DIURNO)).toBe("2026-10-11");
    expect(diaDeNegocio(new Date("2026-10-11T06:30:00Z"), "America/Merida", null)).toBe("2026-10-11");
  });
});
