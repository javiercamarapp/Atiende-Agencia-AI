// Rn-P3-05 -- extraccion del codigo de confirmacion del canal y de los ultimos 4 digitos del telefono, contra una fixture
// anonimizada con el formato de export de Airbnb (DESCRIPTION con la URL de la reserva y la linea de telefono, plegada y con `\n`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extraerDatosCanal, parsearIcs } from "../src/ical/parser.ts";

const FIXTURE = readFileSync(new URL("./fixtures/airbnb-reserva.ics", import.meta.url), "utf8");

describe("parsearIcs -- codigo de confirmacion y ultimos 4 del telefono (Airbnb)", () => {
  it("extrae HM... y los 4 digitos de un DESCRIPTION plegado con \\n escapado", () => {
    const [reserva] = parsearIcs(FIXTURE).eventos;
    expect(reserva!.codigoConfirmacion).toBe("HMAB12CD34");
    expect(reserva!.telefonoUltimos4).toBe("0123");
    // El uid sigue siendo el del evento: el codigo NO lo reemplaza.
    expect(reserva!.uid).toBe("1418fb94e984-ff1c0a7c0f3f@airbnb.com");
  });

  it("un evento sin DESCRIPTION (bloqueo 'Not available') no rompe nada y deja ambos en null", () => {
    const eventos = parsearIcs(FIXTURE).eventos;
    expect(eventos).toHaveLength(2);
    expect(eventos[1]!.codigoConfirmacion).toBeNull();
    expect(eventos[1]!.telefonoUltimos4).toBeNull();
  });

  it("un DESCRIPTION sin codigo ni telefono no inventa nada", () => {
    expect(extraerDatosCanal("Reservation URL: https://www.airbnb.com/hosting/reservations", "Reserved")).toEqual({ codigoConfirmacion: null, telefonoUltimos4: null });
  });

  it("no toma un codigo de un dominio ajeno ni uno con longitud incorrecta", () => {
    expect(extraerDatosCanal("https://evil.example/hosting/reservations/details/HMAB12CD34", null).codigoConfirmacion).toBeNull();
    expect(extraerDatosCanal("https://www.airbnb.com/hosting/reservations/details/HMAB12CD345", null).codigoConfirmacion).toBeNull();
    expect(extraerDatosCanal("https://www.airbnb.com/hosting/reservations/details/HMAB12C", null).codigoConfirmacion).toBeNull();
  });

  it("acepta dominios regionales (airbnb.com.mx) y no se degrada con entradas patologicas (tiempo lineal)", () => {
    expect(extraerDatosCanal("https://www.airbnb.com.mx/hosting/reservations/details/HMAB12CD34", null).codigoConfirmacion).toBe("HMAB12CD34");
    const patologico = "airbnb.".repeat(1100) + "x";
    const t0 = performance.now();
    expect(extraerDatosCanal(patologico, null).codigoConfirmacion).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("solo acepta exactamente 4 digitos para el telefono", () => {
    expect(extraerDatosCanal("Phone Number (Last 4 Digits): 12345", null).telefonoUltimos4).toBeNull();
    expect(extraerDatosCanal("Phone Number (Last 4 Digits): 12a4", null).telefonoUltimos4).toBeNull();
    expect(extraerDatosCanal("Phone Number (Last 4 Digits): 9876", null).telefonoUltimos4).toBe("9876");
  });

  it("Booking.com y Vrbo quedan en null: no hay patron verificado con fixture real", () => {
    const booking = "CLOSED - Not available (Booking.com reservation 998877)";
    expect(extraerDatosCanal(null, booking)).toEqual({ codigoConfirmacion: null, telefonoUltimos4: null });
    expect(extraerDatosCanal("Reservation ID: ABC12345", "Vrbo reservation")).toEqual({ codigoConfirmacion: null, telefonoUltimos4: null });
  });
});
