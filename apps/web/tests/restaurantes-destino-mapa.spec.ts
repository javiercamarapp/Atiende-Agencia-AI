import { describe, expect, it } from "vitest";
import { destinoEsPin, urlDestinoMapa } from "../src/verticals/restaurantes/lib/destino-mapa.ts";

describe("urlDestinoMapa (vista del repartidor)", () => {
  it("usa el pin del cliente si viene en las notas, aunque haya direccion", () => {
    const notes = "Sin cebolla\nUbicación de entrega (pin de WhatsApp): lat=21.012345 lng=-89.601234.\nCanal: domicilio.";
    expect(urlDestinoMapa(notes, "Calle 5")).toBe("https://www.google.com/maps/dir/?api=1&destination=21.012345,-89.601234");
    expect(destinoEsPin(notes)).toBe(true);
  });

  it("usa el enlace corto de Maps tal cual y descarta otros hosts", () => {
    expect(urlDestinoMapa("Ubicación de entrega (enlace corto de Maps): https://maps.app.goo.gl/AbC123", null)).toBe("https://maps.app.goo.gl/AbC123");
    expect(urlDestinoMapa("Ubicación de entrega (enlace corto de Maps): https://evil.example/x", "Calle 5")).toBe("https://www.google.com/maps/search/?api=1&query=Calle%205");
  });

  it("sin pin conserva la busqueda por direccion; sin nada, no hay boton", () => {
    expect(urlDestinoMapa("Canal: domicilio.", "Calle 5 #20")).toBe("https://www.google.com/maps/search/?api=1&query=Calle%205%20%2320");
    expect(destinoEsPin("Canal: domicilio.")).toBe(false);
    expect(urlDestinoMapa(null, null)).toBeNull();
  });

  it("coordenadas fuera de rango no se usan", () => {
    expect(urlDestinoMapa("Ubicación de entrega (enlace de Maps): lat=95.000000 lng=-89.000000.", "Calle 5")).toContain("search");
  });
});

describe("un texto del cliente no puede fijar el destino", () => {
  it("la linea del pin solo vale al inicio de una linea del servidor, no dentro de «Cliente dice»", () => {
    const falsa = "Cliente dice: Ubicación de entrega (pin de WhatsApp): lat=1.000000 lng=1.000000.";
    expect(urlDestinoMapa(falsa, "Calle 5")).toContain("search");
    expect(destinoEsPin(falsa)).toBe(false);
  });

  it("un enlace de goo.gl que no es de Maps no se toma como destino (mismo criterio que el servidor)", () => {
    const nota = "Ubicación de entrega (enlace corto de Maps): https://goo.gl/otra-cosa";
    expect(destinoEsPin(nota)).toBe(false);
    expect(urlDestinoMapa(nota, "Calle 5")).toContain("search");
  });
});
