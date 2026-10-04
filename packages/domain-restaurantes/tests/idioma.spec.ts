import { describe, expect, it } from "vitest";
import { detectarIdioma, idiomaDeConversacion, idiomaDeMensaje, saludoPorHoraEn } from "../src/idioma.ts";

describe("idioma del cliente (R-44)", () => {
  it("detecta ingles en mensajes claros de pedido", () => {
    expect(idiomaDeMensaje("Hi, I would like to order some tacos please")).toBe("en");
    expect(idiomaDeMensaje("Can I pick up my order at the branch?")).toBe("en");
    expect(idiomaDeMensaje("What time do you close today?")).toBe("en");
  });

  it("detecta espanol en mensajes claros, con jerga y sin acentos", () => {
    expect(idiomaDeMensaje("Buenas tardes, quiero unos tacos de bistec para llevar")).toBe("es");
    expect(idiomaDeMensaje("cuanto cuesta la orden de pastor?")).toBe("es");
    expect(idiomaDeMensaje("a domicilio por favor, en la colonia Centro")).toBe("es");
  });

  it("un mensaje ambiguo no decide (numero, 'ok', nombre de producto)", () => {
    expect(idiomaDeMensaje("2")).toBeNull();
    expect(idiomaDeMensaje("tacos al pastor")).toBeNull();
    expect(idiomaDeMensaje("")).toBeNull();
  });

  it("sin senales claras es espanol por omision", () => {
    expect(detectarIdioma([])).toBe("es");
    expect(detectarIdioma(["2", "Ana"])).toBe("es");
  });

  it("un mensaje ambiguo conserva el idioma que traia la conversacion", () => {
    expect(detectarIdioma(["Hello, I want to order tacos please", "tacos al pastor"])).toBe("en");
    expect(detectarIdioma(["Hola, quiero hacer un pedido", "ok"])).toBe("es");
  });

  it("el cliente puede cambiar de idioma a mitad de la conversacion", () => {
    expect(detectarIdioma(["Hello, I want to order tacos please", "Mejor en español, quiero pedir a domicilio por favor"])).toBe("es");
    expect(detectarIdioma(["Hola, quiero un pedido", "Sorry, can we continue in English please? I would like two orders"])).toBe("en");
  });

  it("ignora los marcadores que antepone el sistema", () => {
    expect(idiomaDeMensaje("[Nota de voz transcrita] I want two orders of al pastor please")).toBe("en");
    expect(idiomaDeMensaje("[Ubicación compartida por WhatsApp] lat=20.9 lng=-89.6")).toBeNull();
  });

  it("idiomaDeConversacion solo mira los mensajes del cliente", () => {
    expect(
      idiomaDeConversacion([
        { role: "user", content: "Hello, I would like to order please" },
        { role: "assistant", content: "Buenas tardes, ¿es para recoger o a domicilio? Gracias por escribir a nuestro restaurante." },
        { role: "user", content: "pickup" },
      ]),
    ).toBe("en");
  });

  it("saludo en ingles por franja", () => {
    expect(saludoPorHoraEn(9)).toBe("good morning");
    expect(saludoPorHoraEn(15)).toBe("good afternoon");
    expect(saludoPorHoraEn(22)).toBe("good evening");
    expect(saludoPorHoraEn(3)).toBe("good evening");
  });
});
