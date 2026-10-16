// QA-restaurantes-R1-automatizacion-03: el calendario del tablero (Hoy, dias, meses, horas) sigue la zona horaria del NEGOCIO, no la
// del proceso. Estos casos usan instantes UTC explicitos y una zona explicita: pasan igual con cualquier TZ del proceso.
import { describe, expect, it } from "vitest";
import { buildComparisonPeriods, buildTrendBuckets, horasAbiertasHoy } from "../src/kpis.ts";

const MERIDA = "America/Merida";
const TIJUANA = "America/Tijuana";

describe("horasAbiertasHoy", () => {
  const PM = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
  const SABADO_15_MERIDA = new Date("2026-10-03T21:00:00Z");

  it("PM (12:00 a 01:00, todos los dias): el tramo de la madrugada (cola de la cena de ayer) y de 12:00 a 23:00", () => {
    expect(horasAbiertasHoy([PM], SABADO_15_MERIDA, MERIDA)).toEqual([0, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it("un horario solo de lunes a viernes no aporta horas un sabado (y la cola del viernes si)", () => {
    const entreSemana = [{ dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "01:00" }];
    expect(horasAbiertasHoy([entreSemana], SABADO_15_MERIDA, MERIDA)).toEqual([0]);
  });

  it("sin ningun horario configurado devuelve null (dia completo, nunca un rango inventado); une sucursales", () => {
    expect(horasAbiertasHoy([null, []], SABADO_15_MERIDA, MERIDA)).toBeNull();
    const desayunos = [{ dias: [6], abre: "08:00", cierra: "11:30" }];
    const horas = horasAbiertasHoy([PM, desayunos], SABADO_15_MERIDA, MERIDA)!;
    expect(horas).toContain(8);
    expect(horas).toContain(11);
    expect(horas).toContain(23);
  });
});

describe("limites de dia, semana y mes en la zona del negocio", () => {
  it("Hoy en Merida (proceso en cualquier TZ): empieza a las 06:00Z y 'ayer' a las 06:00Z del dia anterior", () => {
    const { current, previous } = buildComparisonPeriods("today", new Date("2026-10-03T21:00:00Z"), MERIDA);
    expect(current.start.toISOString()).toBe("2026-10-03T06:00:00.000Z");
    expect(previous!.start.toISOString()).toBe("2026-10-02T06:00:00.000Z");
    expect(previous!.end.toISOString()).toBe("2026-10-03T06:00:00.000Z");
  });

  it("a las 00:30 de Merida (06:30Z) 'Hoy' ya es el dia nuevo; a las 23:30 del dia anterior (05:30Z) todavia es el anterior", () => {
    expect(buildComparisonPeriods("today", new Date("2026-10-04T06:30:00Z"), MERIDA).current.start.toISOString()).toBe("2026-10-04T06:00:00.000Z");
    expect(buildComparisonPeriods("today", new Date("2026-10-04T05:30:00Z"), MERIDA).current.start.toISOString()).toBe("2026-10-03T06:00:00.000Z");
  });

  it("zona con horario de verano (Tijuana): el dia del cambio de hora (1-nov-2026) mide 25 h y sus tramos no se corren", () => {
    const ahora = new Date("2026-11-01T20:00:00Z"); // 12:00 PST del 1-nov
    const { current } = buildComparisonPeriods("today", ahora, TIJUANA);
    expect(current.start.toISOString()).toBe("2026-11-01T07:00:00.000Z"); // 00:00 PDT (UTC-7)
    const tramos = buildTrendBuckets("today", ahora, null, { zonaHoraria: TIJUANA });
    expect(tramos).toHaveLength(24);
    expect(tramos[0]!.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(tramos[23]!.end.toISOString()).toBe("2026-11-02T08:00:00.000Z"); // 00:00 PST del 2-nov (UTC-8): 25 h despues
    // 7 dias: cada tramo empieza a las 00:00 locales aun cruzando el cambio de hora.
    const semana = buildTrendBuckets("7", ahora, null, { zonaHoraria: TIJUANA });
    expect(semana).toHaveLength(7);
    expect(semana.at(-1)!.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(semana[0]!.start.toISOString()).toBe("2026-10-26T07:00:00.000Z");
  });

  it("tramos semanales (7) en Merida: etiquetas de dia de la semana LOCAL (el sabado 3-oct a las 21:00Z es sabado, no domingo)", () => {
    const semana = buildTrendBuckets("7", new Date("2026-10-04T03:30:00Z"), null, { zonaHoraria: MERIDA }); // sabado 21:30 Merida
    expect(semana.at(-1)!.label).toBe("sáb");
    expect(semana.at(-1)!.start.toISOString()).toBe("2026-10-03T06:00:00.000Z");
  });

  it("meses (365): el mes empieza el dia 1 a las 00:00 locales (06:00Z), no a las 00:00Z", () => {
    const meses = buildTrendBuckets("365", new Date("2026-10-15T12:00:00Z"), null, { zonaHoraria: MERIDA });
    expect(meses).toHaveLength(12);
    expect(meses.at(-1)!.start.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(meses.at(-1)!.label).toBe("oct 26");
    expect(meses[0]!.label).toBe("nov 25");
  });

  it("sin zona explicita usa la de plataforma (America/Mexico_City, UTC-6): mismo 'Hoy' que Merida", () => {
    expect(buildComparisonPeriods("today", new Date("2026-10-03T21:00:00Z")).current.start.toISOString()).toBe("2026-10-03T06:00:00.000Z");
  });
});
