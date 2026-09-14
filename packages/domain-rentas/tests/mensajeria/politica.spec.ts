import { describe, expect, it } from "vitest";
import { ContenidoProhibidoError, contieneLenguajeExcluyente, detectarContactoOPago, MensajeExcedeLongitudError, politicaDeCanal, validarMensajeSaliente } from "../../src/mensajeria/politica.ts";

describe("politicaDeCanal", () => {
  it("airbnb bloquea contacto/pago pre-reserva; booking/vrbo redactan", () => {
    expect(politicaDeCanal("airbnb").accionAntePreReservaProhibida).toBe("bloquear");
    expect(politicaDeCanal("booking").accionAntePreReservaProhibida).toBe("redactar");
    expect(politicaDeCanal("vrbo").accionAntePreReservaProhibida).toBe("redactar");
  });

  it("booking no permite automatización pre-reserva; airbnb sí", () => {
    expect(politicaDeCanal("booking").permiteAutomatizacionPreReserva).toBe(false);
    expect(politicaDeCanal("airbnb").permiteAutomatizacionPreReserva).toBe(true);
  });
});

describe("detectarContactoOPago", () => {
  it("detecta email, teléfono, URL y palabra de pago externo", () => {
    const h = detectarContactoOPago("Escríbeme a juan@correo.com o al 555-123-4567, o paga por paypal en https://pago.mx");
    expect(h.emails).toEqual(["juan@correo.com"]);
    expect(h.telefonos.length).toBeGreaterThan(0);
    expect(h.urls.length).toBeGreaterThan(0);
    expect(h.palabrasPago).toEqual(["paypal"]);
  });

  it("un número corto (ej. 'habitación 2') no se marca como teléfono", () => {
    const h = detectarContactoOPago("Tu habitación es la 2, junto al elevador");
    expect(h.telefonos).toEqual([]);
  });
});

describe("contieneLenguajeExcluyente", () => {
  it("combina verbo de exclusión + característica protegida", () => {
    expect(contieneLenguajeExcluyente("no aceptamos huéspedes de cierta religión")).toBe(true);
  });

  it("un verbo de exclusión sin característica protegida no dispara", () => {
    expect(contieneLenguajeExcluyente("no aceptamos mascotas en la propiedad")).toBe(false);
  });
});

describe("validarMensajeSaliente", () => {
  it("rechaza un mensaje que excede el máximo de caracteres del canal", () => {
    const texto = "x".repeat(4001);
    expect(() => validarMensajeSaliente({ canal: "airbnb", texto, reservaConfirmada: true })).toThrow(MensajeExcedeLongitudError);
  });

  it("rechaza lenguaje excluyente sin importar el canal ni el estado de la reserva", () => {
    expect(() => validarMensajeSaliente({ canal: "airbnb", texto: "no rentamos a personas de cierta nacionalidad", reservaConfirmada: true })).toThrow(ContenidoProhibidoError);
  });

  it("airbnb: contacto directo pre-reserva se BLOQUEA (nunca se redacta)", () => {
    expect(() => validarMensajeSaliente({ canal: "airbnb", texto: "escríbeme a juan@correo.com", reservaConfirmada: false })).toThrow(ContenidoProhibidoError);
  });

  it("booking: contacto directo pre-reserva se REDACTA, el resto del mensaje se conserva", () => {
    const resultado = validarMensajeSaliente({ canal: "booking", texto: "Hola, escríbeme a juan@correo.com para coordinar", reservaConfirmada: false });
    expect(resultado.redactado).toBe(true);
    expect(resultado.texto).toContain("[correo oculto]");
    expect(resultado.texto).toContain("Hola,");
    expect(resultado.texto).not.toContain("juan@correo.com");
  });

  it("con reserva confirmada, el contacto directo pasa sin redactar en cualquier canal", () => {
    const resultado = validarMensajeSaliente({ canal: "booking", texto: "Contáctame a juan@correo.com", reservaConfirmada: true });
    expect(resultado.redactado).toBe(false);
    expect(resultado.texto).toContain("juan@correo.com");
  });

  it("un mensaje sin ningún hallazgo pasa igual, sin reservaConfirmada", () => {
    const resultado = validarMensajeSaliente({ canal: "vrbo", texto: "¡Hola! Gracias por tu mensaje.", reservaConfirmada: false });
    expect(resultado.redactado).toBe(false);
  });
});
