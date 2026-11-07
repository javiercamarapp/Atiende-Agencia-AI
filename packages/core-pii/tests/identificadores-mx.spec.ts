// Redaccion de CURP, RFC y pasaporte (paridad3 H-P3-03, L-HIS-19). Los valores de prueba son sinteticos.
import { describe, expect, it } from "vitest";
import { redactarDatosDePago, redactarDatosDePagoEIdentidad, redactarIdentificadoresMx } from "../src/index.ts";

describe("redactarIdentificadoresMx", () => {
  it("oculta una CURP en mayusculas, en minusculas y dentro de una frase", () => {
    expect(redactarIdentificadoresMx("mi curp es PEPJ850315HDFRRN09 gracias")).toBe("mi curp es [curp oculta] gracias");
    expect(redactarIdentificadoresMx("pepj850315hdfrrn09")).toBe("[curp oculta]");
    expect(redactarIdentificadoresMx("CURP: GOMA900229MJCNRL05.")).toBe("CURP: [curp oculta].");
  });

  it("oculta un RFC de persona fisica y uno de persona moral", () => {
    expect(redactarIdentificadoresMx("mi RFC es PEPJ850315AB1")).toBe("mi RFC es [rfc oculto]");
    expect(redactarIdentificadoresMx("factura a ABC010203XY9 por favor")).toBe("factura a [rfc oculto] por favor");
    expect(redactarIdentificadoresMx("&AB991231A12")).toBe("[rfc oculto]");
  });

  it("una CURP completa se oculta una sola vez (no deja un RFC pegado)", () => {
    expect(redactarIdentificadoresMx("PEPJ850315HDFRRN09")).toBe("[curp oculta]");
  });

  it("conserva los RFC genericos del SAT, que no identifican a nadie", () => {
    expect(redactarIdentificadoresMx("RFC XAXX010101000")).toBe("RFC XAXX010101000");
    expect(redactarIdentificadoresMx("RFC XEXX010101000")).toBe("RFC XEXX010101000");
  });

  it("oculta un pasaporte solo cuando lleva su etiqueta", () => {
    expect(redactarIdentificadoresMx("mi pasaporte es G12345678")).toBe("mi pasaporte es [pasaporte oculto]");
    expect(redactarIdentificadoresMx("Pasaporte No. 123456789")).toBe("Pasaporte No. [pasaporte oculto]");
    expect(redactarIdentificadoresMx("passport: X1234567")).toBe("passport: [pasaporte oculto]");
    expect(redactarIdentificadoresMx("pasaporte AB123456 vence en 2030")).toBe("pasaporte [pasaporte oculto] vence en 2030");
  });

  it("no toca folios, telefonos, montos, fechas ni palabras comunes", () => {
    const inocentes = [
      "folio F-000123 de la reserva",
      "reserva HTL-2026-00045 confirmada",
      "mi telefono es 9981234567 y el de mi esposa +52 998 123 4567",
      "el total es $12,345.67 MXN y el anticipo 3500",
      "llegamos el 2026-10-14 a las 15:00",
      "habitacion 305 piso 3, dos adultos",
      "pasaporte vigente, lo llevo conmigo",
      "el pasaporte lo muestro en recepcion",
      "numero de reserva 20260314",
      "ya pague con transferencia SPEI referencia 1234567890",
      "calle Insurgentes Sur 1234, colonia Del Valle",
    ];
    for (const t of inocentes) expect(redactarIdentificadoresMx(t), t).toBe(t);
  });

  it("no oculta una cadena de 12-13 caracteres cuya 'fecha' no es valida", () => {
    expect(redactarIdentificadoresMx("ABCD991399XYZ")).toBe("ABCD991399XYZ");
    expect(redactarIdentificadoresMx("ABC000000XYZ")).toBe("ABC000000XYZ");
  });

  it("es idempotente", () => {
    const una = redactarIdentificadoresMx("curp PEPJ850315HDFRRN09 rfc PEPJ850315AB1 pasaporte G12345678");
    expect(redactarIdentificadoresMx(una)).toBe(una);
  });
});

describe("redactarDatosDePagoEIdentidad", () => {
  it("compone pago e identidad sin cambiar las etiquetas de pago que afirman citas y restaurantes", () => {
    const entrada = "tarjeta 4242 4242 4242 4242 cvv 123 vence 09/28 curp PEPJ850315HDFRRN09";
    expect(redactarDatosDePagoEIdentidad(entrada)).toBe("tarjeta [tarjeta oculta] [cvv oculto] vence [vencimiento oculto] curp [curp oculta]");
  });

  it("redactarDatosDePago (compartida con citas y restaurantes) NO cambia su comportamiento", () => {
    expect(redactarDatosDePago("mi curp PEPJ850315HDFRRN09 y rfc PEPJ850315AB1")).toBe("mi curp PEPJ850315HDFRRN09 y rfc PEPJ850315AB1");
  });
});
