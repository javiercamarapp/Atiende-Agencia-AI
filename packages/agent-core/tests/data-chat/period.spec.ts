import { describe, expect, it } from "vitest";
import { resolvePeriod, startOfLocalDay, MAX_PERIOD_DAYS } from "../../src/data-chat/period.js";

const TZ = "America/Merida";
// 29-sep-2026 (martes) 23:30 en Mérida = 30-sep 05:30 UTC.
const NOW = new Date("2026-09-30T05:30:00.000Z");

function ok(args: Record<string, string>, now = NOW) {
  const r = resolvePeriod(args, now, TZ);
  if (!r.ok) throw new Error(`esperaba ok: ${r.message}`);
  return r.period;
}

describe("resolvePeriod en America/Merida", () => {
  it("'hoy' es el día LOCAL aunque en UTC ya sea mañana", () => {
    const p = ok({ periodo: "hoy" });
    expect(p.fromDate).toBe("2026-09-29");
    expect(p.toDate).toBe("2026-09-29");
    expect(p.start.toISOString()).toBe("2026-09-29T06:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-09-30T06:00:00.000Z");
  });

  it("'ayer'", () => {
    const p = ok({ periodo: "ayer" });
    expect([p.fromDate, p.toDate]).toEqual(["2026-09-28", "2026-09-28"]);
  });

  it("últimos 7 días incluye hoy y 6 anteriores; 30 y 90 igual", () => {
    expect(ok({ periodo: "ultimos_7_dias" }).fromDate).toBe("2026-09-23");
    expect(ok({ periodo: "ultimos_30_dias" }).fromDate).toBe("2026-08-31");
    expect(ok({ periodo: "ultimos_90_dias" }).fromDate).toBe("2026-07-02");
  });

  it("semana: lunes a domingo; esta_semana llega solo hasta hoy", () => {
    const esta = ok({ periodo: "esta_semana" });
    expect([esta.fromDate, esta.toDate]).toEqual(["2026-09-28", "2026-09-29"]);
    const pasada = ok({ periodo: "semana_pasada" });
    expect([pasada.fromDate, pasada.toDate]).toEqual(["2026-09-21", "2026-09-27"]);
  });

  it("si hoy es domingo, 'esta_semana' abarca desde el lunes anterior", () => {
    const domingo = new Date("2026-10-04T18:00:00.000Z"); // dom 4-oct 12:00 Mérida
    const p = ok({ periodo: "esta_semana" }, domingo);
    expect([p.fromDate, p.toDate]).toEqual(["2026-09-28", "2026-10-04"]);
  });

  it("mes: este_mes usa el mes LOCAL (1-oct 04:00 UTC sigue siendo 30-sep en Mérida)", () => {
    const finDeMes = new Date("2026-10-01T04:00:00.000Z");
    const p = ok({ periodo: "este_mes" }, finDeMes);
    expect([p.fromDate, p.toDate]).toEqual(["2026-09-01", "2026-09-30"]);
    const pasado = ok({ periodo: "mes_pasado" }, finDeMes);
    expect([pasado.fromDate, pasado.toDate]).toEqual(["2026-08-01", "2026-08-31"]);
  });

  it("mes_pasado en enero cruza de año", () => {
    const p = ok({ periodo: "mes_pasado" }, new Date("2026-01-15T18:00:00.000Z"));
    expect([p.fromDate, p.toDate]).toEqual(["2025-12-01", "2025-12-31"]);
    expect(p.label).toContain("2025");
  });

  it("fechas exactas inclusivas", () => {
    const p = ok({ desde: "2026-09-01", hasta: "2026-09-15" });
    expect(p.start.toISOString()).toBe("2026-09-01T06:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-09-16T06:00:00.000Z");
    expect(p.label).toContain("1 sep al 15 sep 2026");
  });

  it("periodo ambiguo (sin nada) pide aclaración, no asume un default", () => {
    const r = resolvePeriod({}, NOW, TZ);
    expect(r).toMatchObject({ ok: false, kind: "needs_clarification" });
  });

  it("solo 'desde' pide aclaración", () => {
    expect(resolvePeriod({ desde: "2026-09-01" }, NOW, TZ)).toMatchObject({ ok: false, kind: "needs_clarification" });
  });

  it("rechaza ambos modos a la vez, fechas invertidas, futuras, imposibles y rangos enormes", () => {
    expect(resolvePeriod({ periodo: "hoy", desde: "2026-09-01", hasta: "2026-09-02" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolvePeriod({ desde: "2026-09-10", hasta: "2026-09-01" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolvePeriod({ desde: "2026-10-05", hasta: "2026-10-06" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolvePeriod({ desde: "2026-02-30", hasta: "2026-03-02" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(resolvePeriod({ desde: "2024-01-01", hasta: "2026-09-01" }, NOW, TZ)).toMatchObject({ ok: false, kind: "invalid" });
    expect(MAX_PERIOD_DAYS).toBe(366);
  });

  it("zona inválida cae a America/Merida en vez de lanzar", () => {
    const r = resolvePeriod({ periodo: "hoy" }, NOW, "No/Existe");
    expect(r.ok && r.period.timezone).toBe("America/Merida");
  });

  it("startOfLocalDay respeta horario de verano de otras zonas", () => {
    // America/Chicago en julio es UTC-5 (CDT)
    expect(startOfLocalDay(2026, 7, 4, "America/Chicago").toISOString()).toBe("2026-07-04T05:00:00.000Z");
    // y en enero UTC-6 (CST)
    expect(startOfLocalDay(2026, 1, 4, "America/Chicago").toISOString()).toBe("2026-01-04T06:00:00.000Z");
  });
});
