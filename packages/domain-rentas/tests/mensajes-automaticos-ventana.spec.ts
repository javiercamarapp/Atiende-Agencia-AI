// Rn-25 -- ventana de disparo por zona horaria. Misma regla que rentas.sistema_listar_mensajes_automaticos
// (SQL, verificada contra Postgres real en scripts/verify-rentas-mensajes-automaticos). Los instantes
// de referencia son UTC fijos: nunca dependen de la zona del proceso ni del reloj real.
import { describe, expect, it } from "vitest";
import { enVentanaDisparo, instanteDisparo } from "../src/index.ts";

const RESERVA = { checkIn: "2030-06-10", checkOut: "2030-06-12", zonaHoraria: "America/Mexico_City" };

describe("instanteDisparo", () => {
  it("pre_llegada -48 h con check-in el 10 cae el 8 a las 00:00 CDMX (06:00Z)", () => {
    expect(instanteDisparo("2030-06-10", -48, "America/Mexico_City").toISOString()).toBe("2030-06-08T06:00:00.000Z");
  });

  it("respeta la zona de la propiedad: la misma hora de pared en Tokio es 9 h antes que en UTC", () => {
    expect(instanteDisparo("2030-06-10", 10, "Asia/Tokyo").toISOString()).toBe("2030-06-10T01:00:00.000Z");
  });

  it("una zona invalida cae al default de plataforma (CDMX) en vez de lanzar", () => {
    expect(instanteDisparo("2030-06-10", 0, "Nunca/Existio").toISOString()).toBe("2030-06-10T06:00:00.000Z");
  });

  it("el offset es de hora de PARED: cruza el cambio de horario de verano sin desfasarse (Nueva York, marzo 2030)", () => {
    // 2030-03-10 02:00 EST -> 03:00 EDT. 00:00 del 11 + 0 h = 04:00Z (ya en horario de verano); el dia 9 a las 00:00 = 05:00Z.
    expect(instanteDisparo("2030-03-11", 0, "America/New_York").toISOString()).toBe("2030-03-11T04:00:00.000Z");
    expect(instanteDisparo("2030-03-09", 0, "America/New_York").toISOString()).toBe("2030-03-09T05:00:00.000Z");
  });

  it("rechaza una fecha con formato invalido", () => {
    expect(() => instanteDisparo("10/06/2030", 0, "America/Mexico_City")).toThrow(/Fecha invalida/);
  });
});

describe("enVentanaDisparo", () => {
  const pre = { evento: "pre_llegada" as const, offsetHoras: -48, ...RESERVA };

  it("antes del disparo no, en el instante exacto si, y a las 24 h exactas ya no", () => {
    expect(enVentanaDisparo(pre, new Date("2030-06-08T05:59:59Z"))).toBe(false);
    expect(enVentanaDisparo(pre, new Date("2030-06-08T06:00:00Z"))).toBe(true);
    expect(enVentanaDisparo(pre, new Date("2030-06-09T05:59:59Z"))).toBe(true);
    expect(enVentanaDisparo(pre, new Date("2030-06-09T06:00:00Z"))).toBe(false);
  });

  it("cruce de medianoche (leccion de #241): a las 23:30 CDMX del 7 el dia UTC ya es el 8 pero el mensaje del 8 00:00 CDMX todavia NO sale", () => {
    // 23:30 del 7 en CDMX = 05:30Z del 8.
    expect(enVentanaDisparo(pre, new Date("2030-06-08T05:30:00Z"))).toBe(false);
    // 00:30 del 8 en CDMX = 06:30Z del 8: ya si.
    expect(enVentanaDisparo(pre, new Date("2030-06-08T06:30:00Z"))).toBe(true);
  });

  it("check_out y resena usan la fecha de salida como ancla; check_in y pre_llegada la de llegada", () => {
    const out = { evento: "check_out" as const, offsetHoras: 8, ...RESERVA };
    // salida el 12 + 8 h = 08:00 CDMX = 14:00Z.
    expect(enVentanaDisparo(out, new Date("2030-06-12T13:59:00Z"))).toBe(false);
    expect(enVentanaDisparo(out, new Date("2030-06-12T14:00:00Z"))).toBe(true);
    const resena = { evento: "resena" as const, offsetHoras: 24, ...RESERVA };
    expect(enVentanaDisparo(resena, new Date("2030-06-13T05:59:00Z"))).toBe(false);
    expect(enVentanaDisparo(resena, new Date("2030-06-13T06:00:00Z"))).toBe(true);
    const checkIn = { evento: "check_in" as const, offsetHoras: 10, ...RESERVA };
    expect(enVentanaDisparo(checkIn, new Date("2030-06-10T16:00:00Z"))).toBe(true);
  });

  it("una reserva en una zona distinta se evalua en SU zona (Tokio)", () => {
    const tokio = { evento: "pre_llegada" as const, offsetHoras: -48, checkIn: "2030-06-10", checkOut: "2030-06-12", zonaHoraria: "Asia/Tokyo" };
    expect(enVentanaDisparo(tokio, new Date("2030-06-07T14:59:00Z"))).toBe(false);
    expect(enVentanaDisparo(tokio, new Date("2030-06-07T15:00:00Z"))).toBe(true);
  });
});
