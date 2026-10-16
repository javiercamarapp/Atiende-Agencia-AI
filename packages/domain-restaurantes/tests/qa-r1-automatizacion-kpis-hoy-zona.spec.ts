// QA adversarial R1 (lente automatizacion) -- QA-restaurantes-R1-automatizacion-03.
//
// "Hoy" del tablero de ventas (`/admin/kpis/sales?period=today` y su tendencia por hora) se calcula con
// `startOfDay`/`setHours` de `kpis.ts`, que usan la zona horaria DEL PROCESO. En Vercel el proceso corre en
// UTC, asi que para Los Taquitos de PM (America/Merida, UTC-6, abre 12:00-01:00):
//   - "Hoy" empieza a las 18:00 de AYER en Merida: las ventas de la cena de ayer cuentan como de hoy, y a las
//     18:00 locales el contador "se reinicia" y la comida de hoy desaparece de "Hoy".
//   - Los tramos por hora 11:00-23:00 son horas UTC (05:00-17:00 Merida): la cena (17:00-01:00) nunca aparece.
// Estos specs piden el comportamiento correcto en la zona del negocio sea cual sea la zona del proceso (produccion corre
// en UTC). Estaban ROJOS hasta el fix; ahora pasan.
import { describe, expect, it } from "vitest";
import { buildComparisonPeriods, buildTrendBuckets } from "../src/kpis.ts";

// Con el fix la zona sale de la plataforma (America/Mexico_City, UTC-6), no del proceso: el spec pasa igual con cualquier TZ
// (el job `clock-guard` de CI lo corre con TZ=UTC, America/Merida, Mexico_City y Pacific/Kiritimati).

// Sabado 3-oct-2026, 15:00 en Merida = 21:00Z.
const AHORA = new Date("2026-10-03T21:00:00Z");
// Medianoche de Merida del 3-oct = 06:00Z.
const INICIO_DIA_MERIDA = new Date("2026-10-03T06:00:00Z");

describe("QA-restaurantes-R1-automatizacion-03: 'Hoy' del tablero en la zona del negocio (proceso en UTC)", () => {
  it("una venta de la cena de AYER (viernes 20:00 Merida) no cae en 'Hoy' del sabado", () => {
    const { current } = buildComparisonPeriods("today", AHORA);
    const cenaDeAyer = new Date("2026-10-03T02:00:00Z"); // viernes 2-oct 20:00 en Merida
    const cae = cenaDeAyer >= current.start && cenaDeAyer < current.end;
    expect(cae, `'Hoy' empieza en ${current.start.toISOString()} (deberia ser ${INICIO_DIA_MERIDA.toISOString()})`).toBe(false);
  });

  it("a las 19:00 de Merida (01:00Z del dia siguiente) 'Hoy' sigue incluyendo la comida de las 13:00", () => {
    const ahora = new Date("2026-10-04T01:00:00Z"); // sabado 3-oct 19:00 Merida
    const { current } = buildComparisonPeriods("today", ahora);
    const comida = new Date("2026-10-03T19:00:00Z"); // sabado 13:00 Merida
    expect(comida >= current.start && comida < current.end, `'Hoy' empieza en ${current.start.toISOString()}`).toBe(true);
  });

  it("el tramo '13:00' de la tendencia de hoy corresponde a las 13:00 de Merida (19:00Z)", () => {
    const tramos = buildTrendBuckets("today", AHORA, null);
    const t13 = tramos.find((t) => t.label === "13:00");
    expect(t13?.start.toISOString()).toBe("2026-10-03T19:00:00.000Z");
  });

  it("la tendencia de hoy cubre la cena de PM (21:00-22:00 Merida)", () => {
    const tramos = buildTrendBuckets("today", AHORA, null);
    const cena = new Date("2026-10-04T03:30:00Z"); // sabado 21:30 Merida
    expect(tramos.some((t) => cena >= t.start && cena < t.end)).toBe(true);
  });
});
