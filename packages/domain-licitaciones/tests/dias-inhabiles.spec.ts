// L-22 -- calendario de dias inhabiles: seed 2026-2027 atado a la ley, calculo de plazos con
// feriados, bordes (cruce de fin de anio, puente, plazo que cae en inhabil, America/Mexico_City).
import { describe, expect, it } from "vitest";
import { addBusinessDays, CALENDAR_LIMITATION_NOTE } from "../src/business-days.ts";
import { computePaymentDueDate } from "../src/contract-billing.ts";
import { computeInconformidadDeadline } from "../src/inconformidad.ts";
import {
  DIAS_INHABILES_OFICIALES,
  DIAS_INHABILES_SUGERIDOS,
  DiaInhabilValidationError,
  buildCalendarioPlazos,
  calendarioAvisos,
  countBusinessDaysBetween,
  describirPlazo,
  isBusinessDay,
  isValidDateOnly,
  mexicoCityDateKey,
  nextBusinessDayOnOrAfter,
  officialOnlyCalendar,
  parseDiaInhabilCreate,
} from "../src/dias-inhabiles.ts";
import type { DiaInhabil } from "../src/dias-inhabiles.ts";

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const TENDER = "00000000-0000-0000-0000-00000000000a";

function declarado(fecha: string, extra: Partial<DiaInhabil> = {}): DiaInhabil {
  return { fecha, nombre: "Dia declarado", alcance: "organizacion", tenderId: null, publicadoPor: null, fuente: null, verificacion: "por_validar", ...extra };
}

describe("seed oficial 2026-2027 (LFT art. 74)", () => {
  it("7 dias por anio, solo 2026 y 2027, sin repetidos", () => {
    const byYear = (y: string) => DIAS_INHABILES_OFICIALES.filter((d) => d.fecha.startsWith(y));
    expect(byYear("2026")).toHaveLength(7);
    expect(byYear("2027")).toHaveLength(7);
    expect(DIAS_INHABILES_OFICIALES).toHaveLength(14);
    expect(new Set(DIAS_INHABILES_OFICIALES.map((d) => d.fecha)).size).toBe(14);
    for (const d of DIAS_INHABILES_OFICIALES) expect(isValidDateOnly(d.fecha)).toBe(true);
  });

  it("los feriados movibles caen en el lunes que dice la ley (1er lunes de feb, 3er lunes de mar y nov)", () => {
    const nth = (year: number, month: number, n: number) => {
      let seen = 0;
      for (let day = 1; day <= 31; day += 1) {
        const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (dow(iso) === 1 && ++seen === n) return iso;
      }
      throw new Error("sin lunes");
    };
    for (const year of [2026, 2027]) {
      const fechas = DIAS_INHABILES_OFICIALES.map((d) => d.fecha);
      expect(fechas).toContain(nth(year, 2, 1));
      expect(fechas).toContain(nth(year, 3, 3));
      expect(fechas).toContain(nth(year, 11, 3));
      for (const fixed of ["01-01", "05-01", "09-16", "12-25"]) expect(fechas).toContain(`${year}-${fixed}`);
    }
  });

  it("Jueves/Viernes Santo son SUGERIDOS por validar: no cuentan en el calendario oficial", () => {
    expect(DIAS_INHABILES_SUGERIDOS.map((d) => d.fecha)).toEqual(["2026-04-02", "2026-04-03", "2027-03-25", "2027-03-26"]);
    expect(dow("2026-04-02")).toBe(4);
    expect(dow("2026-04-03")).toBe(5);
    expect(dow("2027-03-25")).toBe(4);
    expect(dow("2027-03-26")).toBe(5);
    const cal = officialOnlyCalendar();
    for (const s of DIAS_INHABILES_SUGERIDOS) expect(cal.holidays).not.toContain(s.fecha);
    for (const s of DIAS_INHABILES_SUGERIDOS) expect(s.motivo).toMatch(/fiscalista\/abogado/);
  });
});

describe("buildCalendarioPlazos", () => {
  it("une oficiales + organizacion + la convocatoria pedida; ignora la de otra convocatoria", () => {
    const cal = buildCalendarioPlazos({
      tenderId: TENDER,
      declarados: [
        declarado("2026-04-02"),
        declarado("2026-04-10", { alcance: "convocatoria", tenderId: TENDER }),
        declarado("2026-04-13", { alcance: "convocatoria", tenderId: "00000000-0000-0000-0000-00000000000b" }),
      ],
    });
    expect(cal.holidays).toContain("2026-04-02");
    expect(cal.holidays).toContain("2026-04-10");
    expect(cal.holidays).not.toContain("2026-04-13");
    expect(cal.holidays).toEqual([...cal.holidays].sort());
    expect(cal.note).toMatch(/2 declarados/);
  });

  it("sin tenderId no aplica ningun dia de convocatoria", () => {
    const cal = buildCalendarioPlazos({ declarados: [declarado("2026-04-10", { alcance: "convocatoria", tenderId: TENDER })] });
    expect(cal.holidays).not.toContain("2026-04-10");
  });

  it("descarta fechas invalidas y un 'oficial' falso declarado por la base", () => {
    const cal = buildCalendarioPlazos({ declarados: [declarado("2026-02-30"), declarado("2026-06-01", { alcance: "oficial" })] });
    expect(cal.holidays).not.toContain("2026-02-30");
    expect(cal.holidays).not.toContain("2026-06-01");
  });

  it("la nota siempre pide validar con fiscalista/abogado", () => {
    expect(officialOnlyCalendar().note).toMatch(/fiscalista\/abogado/);
  });
});

describe("plazos con feriados (bordes)", () => {
  const cal = officialOnlyCalendar();

  it("plazo de pago: 17 habiles desde 2026-01-05 se alargan por el 2 de feb (Constitucion) y por el 1 de ene antes", () => {
    const sin = computePaymentDueDate("2026-01-05");
    const con = computePaymentDueDate("2026-01-05", cal);
    // 17 habiles desde lunes 5-ene: sin feriados cae el martes 27-ene (antes del 2-feb) -> igual
    expect(sin.dueDate).toBe("2026-01-28");
    expect(con.dueDate).toBe(sin.dueDate);
    // desde el 20-ene el 2-feb si entra en la cuenta: el calendario lo recorre un dia
    expect(computePaymentDueDate("2026-01-20", cal).dueDate).not.toBe(computePaymentDueDate("2026-01-20").dueDate);
    expect(addBusinessDays("2026-01-20", 17, cal)).toBe(addBusinessDays("2026-01-20", 18));
  });

  it("cruce de fin de anio: 25-dic (vie) y 1-ene (vie) salen de la cuenta de 6 habiles de inconformidad", () => {
    // fallo notificado jueves 24-dic-2026. Sin feriados: 25(vie) 28 29 30 31 1-ene(vie) -> 6 habiles = 1-ene-2027
    expect(computeInconformidadDeadline("2026-12-24", false).dueDate).toBe("2027-01-01");
    // con calendario: 25-dic y 1-ene inhabiles -> 28 29 30 31 4 5 -> 5-ene-2027
    const r = computeInconformidadDeadline("2026-12-24", false, cal);
    expect(r.dueDate).toBe("2027-01-05");
    expect(r.calendarNote).toMatch(/oficiales de plataforma/);
  });

  it("puente: un feriado en lunes (16-mar-2026) junto al fin de semana no cuenta", () => {
    // viernes 13-mar-2026 + 1 habil: sab, dom, lun 16 (feriado) -> martes 17
    expect(addBusinessDays("2026-03-13", 1, cal)).toBe("2026-03-17");
    expect(addBusinessDays("2026-03-13", 1)).toBe("2026-03-16");
  });

  it("plazo que cae en inhabil se recorre al siguiente habil; uno que ya es habil no se mueve", () => {
    expect(nextBusinessDayOnOrAfter("2026-03-16", cal.holidays)).toBe("2026-03-17");
    expect(nextBusinessDayOnOrAfter("2026-12-25", cal.holidays)).toBe("2026-12-28");
    expect(nextBusinessDayOnOrAfter("2026-03-17", cal.holidays)).toBe("2026-03-17");
    expect(isBusinessDay("2026-03-16", cal.holidays)).toBe(false);
    expect(isBusinessDay("2026-03-16", [])).toBe(true);
  });

  it("un dia declarado por la organizacion (Jueves y Viernes Santo) alarga el plazo; sin declararlo no", () => {
    const sinDeclarar = addBusinessDays("2026-04-01", 2, cal);
    const declarando = addBusinessDays("2026-04-01", 2, buildCalendarioPlazos({ declarados: [declarado("2026-04-02"), declarado("2026-04-03")] }));
    expect(sinDeclarar).toBe("2026-04-03");
    expect(declarando).toBe("2026-04-07");
  });

  it("la nota sin ningun dia inhabil sigue siendo la limitacion honesta", () => {
    expect(computePaymentDueDate("2026-01-05").calendarNote).toBe(CALENDAR_LIMITATION_NOTE);
  });
});

describe("countBusinessDaysBetween", () => {
  it("cuenta habiles en (from, to], negativo si vencio, 0 el mismo dia", () => {
    expect(countBusinessDaysBetween("2026-01-05", "2026-01-12")).toBe(5);
    expect(countBusinessDaysBetween("2026-01-12", "2026-01-05")).toBe(-5);
    expect(countBusinessDaysBetween("2026-01-05", "2026-01-05")).toBe(0);
    // con el 2-feb inhabil
    expect(countBusinessDaysBetween("2026-01-30", "2026-02-03")).toBe(2);
    expect(countBusinessDaysBetween("2026-01-30", "2026-02-03", ["2026-02-02"])).toBe(1);
  });

  it("es consistente con addBusinessDays (to = from + n habiles <=> cuenta n)", () => {
    for (const start of ["2026-12-21", "2026-04-01", "2027-03-22"]) {
      const to = addBusinessDays(start, 7, officialOnlyCalendar());
      expect(countBusinessDaysBetween(start, to, officialOnlyCalendar().holidays)).toBe(7);
    }
  });
});

describe("zona America/Mexico_City", () => {
  it("un instante del 31-dic 23:00 CDMX es 31-dic en Mexico aunque en UTC ya sea 1-ene (inhabil)", () => {
    expect(mexicoCityDateKey("2026-12-31T23:00:00-06:00")).toBe("2026-12-31");
    expect("2026-12-31T23:00:00-06:00".slice(0, 10)).toBe("2026-12-31");
    expect(new Date("2026-12-31T23:00:00-06:00").toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("un instante UTC de madrugada pertenece al dia anterior en CDMX", () => {
    expect(mexicoCityDateKey("2026-03-16T03:00:00Z")).toBe("2026-03-15");
    expect(mexicoCityDateKey("2026-03-16T07:00:00Z")).toBe("2026-03-16");
  });

  it("rechaza un instante invalido", () => {
    expect(() => mexicoCityDateKey("no-es-fecha")).toThrow();
  });
});

describe("avisos de cobertura", () => {
  it("avisa cuando el plazo toca un anio sin calendario y calla cuando la organizacion lo declaro", () => {
    const cal = officialOnlyCalendar();
    expect(calendarioAvisos(cal, "2026-12-20", "2027-01-10")).toEqual([]);
    const avisos = calendarioAvisos(cal, "2028-01-03", "2028-01-20");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/2028/);
    const declarado2028 = buildCalendarioPlazos({ declarados: [declarado("2028-01-01")] });
    expect(calendarioAvisos(declarado2028, "2028-01-03", "2028-01-20")).toEqual([]);
  });

  it("un plazo que cruza de un anio cubierto a uno sin cobertura avisa solo del descubierto", () => {
    const avisos = calendarioAvisos(officialOnlyCalendar(), "2027-12-20", "2028-01-10");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/2028/);
  });
});

describe("parseDiaInhabilCreate", () => {
  it("normaliza una entrada valida", () => {
    expect(parseDiaInhabilCreate({ fecha: "2026-04-02", nombre: "  Jueves Santo ", publicadoPor: "SHCP", fuente: "DOF 2026-01-10" })).toEqual({
      fecha: "2026-04-02",
      nombre: "Jueves Santo",
      tenderId: null,
      publicadoPor: "SHCP",
      fuente: "DOF 2026-01-10",
      verificacion: "por_validar",
    });
  });

  it.each([
    [{ fecha: "2026-02-30", nombre: "Dia inventado" }],
    [{ fecha: "26-02-03", nombre: "Dia raro" }],
    [{ fecha: "1999-12-31", nombre: "Dia antiguo" }],
    [{ fecha: "2026-04-02", nombre: "ab" }],
    [{ fecha: "2026-04-02", nombre: "Dia", tenderId: "no-uuid" }],
    [{ fecha: "2026-04-02", nombre: "Dia valido", verificacion: "quizas" }],
    [{ fecha: "2026-04-02", nombre: "Dia valido", publicadoPor: "x".repeat(201) }],
  ])("rechaza entrada invalida %#", (raw) => {
    expect(() => parseDiaInhabilCreate(raw as Record<string, unknown>)).toThrow(DiaInhabilValidationError);
  });
});

describe("describirPlazo", () => {
  const cal = officialOnlyCalendar();

  it("usa la fecha civil de Mexico: 31-dic 23:00 CDMX no es el 1-ene inhabil", () => {
    const p = describirPlazo("2026-12-31T23:00:00-06:00", "2026-12-28T15:00:00-06:00", cal);
    expect(p.fechaLimite).toBe("2026-12-31");
    expect(p.caeEnInhabil).toBe(false);
    // 28-dic (lun) -> 31-dic (jue): 29, 30, 31 = 3 habiles
    expect(p.diasHabilesRestantes).toBe(3);
  });

  it("avisa cuando el plazo cae en un feriado y propone el siguiente dia habil", () => {
    const p = describirPlazo("2026-03-16T14:00:00-06:00", "2026-03-10T09:00:00-06:00", cal);
    expect(p.caeEnInhabil).toBe(true);
    expect(p.motivoInhabil).toMatch(/Benito Juárez/);
    expect(p.siguienteDiaHabil).toBe("2026-03-17");
    expect(p.avisos.some((a) => /día inhábil/.test(a))).toBe(true);
  });

  it("avisa cuando cae en fin de semana y cuando ya vencio devuelve negativo", () => {
    const sab = describirPlazo("2026-03-14T12:00:00-06:00", "2026-03-10T09:00:00-06:00", cal);
    expect(sab.motivoInhabil).toBe("sábado");
    const vencido = describirPlazo("2026-03-10T12:00:00-06:00", "2026-03-13T09:00:00-06:00", cal);
    expect(vencido.diasHabilesRestantes).toBe(-3);
    expect(vencido.caeEnInhabil).toBe(false);
  });

  it("un plazo en un anio sin calendario avisa y solo excluye fines de semana", () => {
    const p = describirPlazo("2029-06-04T12:00:00-06:00", "2029-06-01T09:00:00-06:00", cal);
    expect(p.avisos.some((a) => /2029/.test(a))).toBe(true);
  });
});
