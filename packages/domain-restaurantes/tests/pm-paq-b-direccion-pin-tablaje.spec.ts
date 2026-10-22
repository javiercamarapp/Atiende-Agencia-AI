// Paquete B (ubicacion y cobertura), piloto PM: en zonas sin calles (privadas, "tablaje catastral") el cliente manda el pin y a veces ni
// escribe direccion. El agente no debe pedir la direccion dos veces ni rechazar un pin valido: con pin o tablaje pide SOLO la referencia
// (color de casa, portón, privada). Todos los datos de estas pruebas son inventados. Determinista, sin LLM.
import { describe, expect, it } from "vitest";
import { evaluarDireccionEntrega, extraerTablaje, faltantesEnUnMensaje, tieneReferenciaDeCasa } from "../src/direccion-pin-tablaje.ts";

describe("extraerTablaje", () => {
  it.each([
    ["tablaje 12345", "12345"],
    ["Tablaje catastral 4567", "4567"],
    ["tablaje catastral no. 98765, privada Palma Real", "98765"],
    ["TABLAJE #321", "321"],
    ["el tablaje: 777", "777"],
  ])("reconoce %j", (texto, esperado) => {
    expect(extraerTablaje(texto)).toBe(esperado);
  });
  it("no inventa tablaje donde no lo hay", () => {
    expect(extraerTablaje("Calle 21 #100 x 10 y 12")).toBeNull();
    expect(extraerTablaje("tablaje")).toBeNull();
    expect(extraerTablaje("")).toBeNull();
  });
});

describe("tieneReferenciaDeCasa", () => {
  it.each(["portón negro", "casa azul", "privada Palma Real", "edificio B depto 26", "frente al parque", "junto a la tienda", "esquina con la privada"])("%j es referencia", (t) => {
    expect(tieneReferenciaDeCasa(t)).toBe(true);
  });
  it.each(["", "Temozón", "ok", "12345"])("%j no es referencia", (t) => {
    expect(tieneReferenciaDeCasa(t)).toBe(false);
  });
});

describe("evaluarDireccionEntrega", () => {
  it("pin + tablaje + referencia: suficiente, no pide la direccion de nuevo", () => {
    const r = evaluarDireccionEntrega({ direccion: "Temozón, tablaje 12345, privada con portón negro", tienePin: true });
    expect(r).toMatchObject({ suficiente: true, faltante: null, tablaje: "12345", usaPin: true });
  });
  it("tablaje sin referencia pero con pin: suficiente (el pin ubica el predio)", () => {
    expect(evaluarDireccionEntrega({ direccion: "tablaje 4567", tienePin: true })).toMatchObject({ suficiente: true, faltante: null });
  });
  it("solo pin, sin texto: no rechaza el pin, pide SOLO la referencia", () => {
    expect(evaluarDireccionEntrega({ direccion: "", tienePin: true })).toMatchObject({ suficiente: false, faltante: "referencia" });
    expect(evaluarDireccionEntrega({ direccion: undefined, tienePin: true })).toMatchObject({ suficiente: false, faltante: "referencia" });
  });
  it("pin + relleno ('ya te mandé todo', 'ahí en la ubicación'): pide solo la referencia", () => {
    expect(evaluarDireccionEntrega({ direccion: "la que te mande", tienePin: true })).toMatchObject({ faltante: "referencia" });
    expect(evaluarDireccionEntrega({ direccion: "pendiente", tienePin: true })).toMatchObject({ faltante: "referencia" });
  });
  it("pin + color de casa: suficiente", () => {
    expect(evaluarDireccionEntrega({ direccion: "casa blanca con reja verde", tienePin: true })).toMatchObject({ suficiente: true, faltante: null });
  });
  it("pin + calle y numero de siempre: suficiente", () => {
    expect(evaluarDireccionEntrega({ direccion: "Calle 21 #100 x 10 y 12", tienePin: true })).toMatchObject({ suficiente: true });
  });
  it("sin pin y sin tablaje: la direccion escrita sigue siendo la regla de siempre", () => {
    expect(evaluarDireccionEntrega({ direccion: "", tienePin: false })).toMatchObject({ suficiente: false, faltante: "direccion" });
    expect(evaluarDireccionEntrega({ direccion: "Calle 21 #100 x 10 y 12", tienePin: false })).toMatchObject({ suficiente: true, faltante: null });
    expect(evaluarDireccionEntrega({ direccion: "pendiente", tienePin: false })).toMatchObject({ faltante: "direccion" });
  });
  it("tablaje sin pin: es una direccion valida en zonas sin calles", () => {
    expect(evaluarDireccionEntrega({ direccion: "tablaje catastral 4567", tienePin: false })).toMatchObject({ suficiente: true, tablaje: "4567", usaPin: false });
  });
});

describe("faltantesEnUnMensaje: una sola pregunta con solo lo que falta", () => {
  it("lista unicamente lo que falta, en un mensaje", () => {
    const m = faltantesEnUnMensaje({ referencia: true, nombre: true, pago: true });
    expect(m).toMatch(/referencia|color de casa/i);
    expect(m).toMatch(/nombre/i);
    expect(m).toMatch(/pago|efectivo|tarjeta/i);
    expect(m).not.toMatch(/calle|número|numero|dirección completa/i);
  });
  it("no repite lo que el cliente ya dio en la rafaga", () => {
    const m = faltantesEnUnMensaje({ referencia: true });
    expect(m).toMatch(/referencia|color de casa/i);
    expect(m).not.toMatch(/nombre/i);
    expect(m).not.toMatch(/pago|efectivo|tarjeta/i);
  });
  it("no hay nada que preguntar: null (el agente sigue con el resumen)", () => {
    expect(faltantesEnUnMensaje({})).toBeNull();
  });
});
