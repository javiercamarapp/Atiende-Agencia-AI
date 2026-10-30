// QA-citas-R1-botones-05/06/07/07b, features-10/14, viaje-13/14: la Agenda calcula dia, rango y hora en la zona del NEGOCIO, no en UTC ni en la del navegador.
import { describe, expect, it } from "vitest";
import { computeRange, groupByDay } from "../src/verticals/citas/lib/agenda-rango.ts";
import { formatDateLong, formatTimeRange } from "../src/verticals/citas/lib/format.ts";
import { zonasHorariasDisponibles } from "../src/verticals/citas/lib/tenant-config-client.ts";
import { datetimeLocalAIso, fechaEnZona, instanteDeHoraLocal, zonaNegocioValida } from "../src/verticals/citas/lib/zona-negocio.ts";

const MERIDA = "America/Merida"; // UTC-6 todo el anio

describe("zona-negocio", () => {
  it("instanteDeHoraLocal / datetimeLocalAIso: la hora de pared se interpreta en la zona del negocio", () => {
    expect(instanteDeHoraLocal("2027-09-13", "10:00", MERIDA).toISOString()).toBe("2027-09-13T16:00:00.000Z");
    expect(datetimeLocalAIso("2027-09-13T10:00", MERIDA)).toBe("2027-09-13T16:00:00.000Z");
    expect(datetimeLocalAIso("2027-09-13T10:00", "America/Tijuana")).toBe("2027-09-13T17:00:00.000Z"); // PDT, UTC-7
    expect(datetimeLocalAIso("", MERIDA)).toBeNull();
    // cruce de horario de verano (Tijuana pasa de PDT a PST el 1-nov-2026)
    expect(instanteDeHoraLocal("2026-11-02", "00:00", "America/Tijuana").toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });
  it("fechaEnZona: el dia local, no el UTC", () => {
    expect(fechaEnZona("2027-09-14T01:30:00.000Z", MERIDA)).toBe("2027-09-13");
  });
  it("zonaNegocioValida cae a la zona por omision ante basura (nunca RangeError)", () => {
    expect(zonaNegocioValida("GMT-6 Merida")).toBe("America/Mexico_City");
    expect(zonaNegocioValida(null)).toBe("America/Mexico_City");
    expect(zonaNegocioValida(MERIDA)).toBe(MERIDA);
  });
});

describe("QA-citas-R1-botones-05 / viaje-13: groupByDay agrupa por dia LOCAL", () => {
  it("una cita el 20 a las 19:30 de Merida (01:30Z del 21) y otra el 21 a las 09:00 quedan en dias distintos", () => {
    const noche = { startsAt: "2026-10-21T01:30:00.000Z", id: "noche" };
    const manana = { startsAt: "2026-10-21T15:00:00.000Z", id: "manana" };
    const grupos = groupByDay([noche, manana], MERIDA);
    expect(grupos.map(([dia, l]) => [dia, l.map((x) => x.id)])).toEqual([["2026-10-20", ["noche"]], ["2026-10-21", ["manana"]]]);
  });
});

describe("QA-citas-R1-botones-06 / viaje-14 / features-14: el rango va de medianoche local a medianoche local", () => {
  it("mes de octubre 2026 en Merida: 06:00Z a 06:00Z; la cita del 31 a las 19:00 (01:00Z del 1-nov) cae dentro", () => {
    const r = computeRange(new Date("2026-10-15T00:00:00.000Z"), "month", MERIDA);
    expect(r.fromIso).toBe("2026-10-01T06:00:00.000Z");
    expect(r.toIso).toBe("2026-11-01T06:00:00.000Z");
    const cita = Date.parse("2026-11-01T01:00:00.000Z");
    expect(cita >= Date.parse(r.fromIso) && cita < Date.parse(r.toIso)).toBe(true);
  });
  it("semana (lunes 28-sep a lunes 5-oct): el domingo 4 a las 19:00 entra y el domingo 27 a las 19:00 no", () => {
    const r = computeRange(new Date("2026-09-30T00:00:00.000Z"), "week", MERIDA);
    expect(r.fromIso).toBe("2026-09-28T06:00:00.000Z");
    expect(r.toIso).toBe("2026-10-05T06:00:00.000Z");
    const dentro = Date.parse("2026-10-05T01:00:00.000Z"); // domingo 4 19:00 Merida
    const fuera = Date.parse("2026-09-28T01:00:00.000Z"); // domingo 27 19:00 Merida
    expect(dentro >= Date.parse(r.fromIso) && dentro < Date.parse(r.toIso)).toBe(true);
    expect(fuera >= Date.parse(r.fromIso)).toBe(false);
    expect(r.label).toBe("Semana del lunes, 28 de septiembre");
  });
});

describe("QA-citas-R1-botones-07b / features-10: las horas se pintan en la zona del negocio", () => {
  it("una cita a las 10:00 de Merida se ve 10:00 aunque el navegador este en otra zona", () => {
    expect(formatTimeRange("2027-09-13T16:00:00.000Z", "2027-09-13T16:30:00.000Z", MERIDA)).toContain("10:00");
    expect(formatTimeRange("2027-09-13T16:00:00.000Z", "2027-09-13T16:30:00.000Z", "America/Tijuana")).toContain("09:00");
    expect(formatDateLong("2027-09-14T01:30:00.000Z", MERIDA)).toMatch(/lunes/);
  });
});

describe("QA-citas-R1-botones-19: la zona horaria se elige de una lista cerrada", () => {
  it("la lista contiene zonas IANA reales, ordenada, e incluye la actual", () => {
    const lista = zonasHorariasDisponibles("America/Merida");
    expect(lista).toContain("America/Merida");
    expect(lista).toContain("America/Mexico_City");
    expect(lista).not.toContain("GMT-6 Merida");
    expect([...lista]).toEqual([...lista].sort((a, b) => a.localeCompare(b)));
  });
});
