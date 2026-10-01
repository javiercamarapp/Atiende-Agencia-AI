// PL-12 guard anti-bombas de tiempo. `hoyFechaNegocio` debe dar el dia de calendario DEL NEGOCIO sin importar
// la zona horaria del proceso (Vercel corre en UTC; un laptop o un runner pueden correr en otra) ni la frontera
// del mes/anio/bisiesto. Relojes simulados con vi.setSystemTime; ningun test lee el reloj real.
// Corre dentro de `npm run test:unit` y tambien en el job `clock-guard` bajo una matriz de TZ del proceso.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "../src/fecha-negocio.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function a(iso: string): void {
  vi.setSystemTime(new Date(iso));
}

describe("23:30 en America/Merida (UTC-6 fijo desde oct-2022)", () => {
  it("23:30 del 31-dic sigue siendo 31-dic en Merida aunque ya sea 1-ene en UTC (cruce de anio)", () => {
    a("2027-01-01T05:30:00.000Z");
    expect(new Date().toISOString().slice(0, 10)).toBe("2027-01-01"); // el patron viejo daria el dia equivocado
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-12-31");
  });

  it("23:30 del 28-feb (anio no bisiesto) es 28-feb; 23:30 del 29-feb-2028 es 29-feb (bisiesto)", () => {
    a("2026-03-01T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-02-28");
    a("2028-03-01T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2028-02-29");
  });

  it("23:30 del ultimo dia de un mes de 30 y de 31 dias no salta al mes siguiente", () => {
    a("2026-05-01T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-04-30");
    a("2026-08-01T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-07-31");
  });

  it("00:00 de Merida ya es el dia nuevo (frontera exacta en 06:00 UTC)", () => {
    a("2026-12-31T05:59:59.999Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-12-30");
    a("2026-12-31T06:00:00.000Z");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-12-31");
  });
});

describe("Cancun (UTC-5 fijo) frente a Merida/CDMX (UTC-6) -- el bug de rentas-pricing", () => {
  it("entre 05:00 y 06:00 UTC Cancun ya esta en el dia nuevo y Merida/CDMX todavia no", () => {
    a("2026-12-31T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Cancun")).toBe("2026-12-31");
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-12-30");
    expect(hoyFechaNegocio("America/Mexico_City")).toBe("2026-12-30");
  });

  it("a las 00:30 de Cancun del 1-ene el anio ya cambio ahi pero no en CDMX", () => {
    a("2027-01-01T05:30:00.000Z");
    expect(hoyFechaNegocio("America/Cancun")).toBe("2027-01-01");
    expect(hoyFechaNegocio("America/Mexico_City")).toBe("2026-12-31");
  });
});

describe("zonas con horario de verano (no deben desfasar el dia en la transicion)", () => {
  it("Tijuana: 23:59 PST del 7-mar-2026 y 00:00 PDT del 9-mar (el 8-mar salta 02:00 -> 03:00)", () => {
    a("2026-03-08T07:59:00.000Z"); // 23:59 PST del dia 7
    expect(hoyFechaNegocio("America/Tijuana")).toBe("2026-03-07");
    a("2026-03-08T10:00:00.000Z"); // 03:00 PDT del dia 8
    expect(hoyFechaNegocio("America/Tijuana")).toBe("2026-03-08");
    a("2026-03-09T06:59:00.000Z"); // 23:59 PDT del dia 8
    expect(hoyFechaNegocio("America/Tijuana")).toBe("2026-03-08");
    a("2026-03-09T07:00:00.000Z"); // 00:00 PDT del dia 9
    expect(hoyFechaNegocio("America/Tijuana")).toBe("2026-03-09");
  });
});

describe("independencia de la zona del proceso", () => {
  it("el resultado depende solo del instante y de la zona pedida, nunca de process.env.TZ", () => {
    a("2027-01-01T05:30:00.000Z");
    // Si el helper leyera la zona local del proceso, esta igualdad se rompe bajo la matriz de TZ del job clock-guard.
    expect(hoyFechaNegocio("America/Merida")).toBe("2026-12-31");
    expect(hoyFechaNegocio("UTC")).toBe("2027-01-01");
    expect(hoyFechaNegocio("Pacific/Kiritimati")).toBe("2027-01-01"); // UTC+14
    expect(hoyFechaNegocio("Pacific/Pago_Pago")).toBe("2026-12-31"); // UTC-11
  });
});
