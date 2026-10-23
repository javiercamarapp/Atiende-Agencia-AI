// PM Ronda 19, G4 / T7-012 (puro + handler en memoria con modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// Una cantidad en piezas que no es multiplo de la orden («4 tacos de bistec», «3 gringas») fija en el prompt del turno que se explique la presentacion y se ofrezcan las opciones validas con precio de la herramienta.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bloqueCantidadNoMultiplo, cantidadesNoMultiplo } from "../src/unidades-pm.ts";
import { MARTES_14H, nuevoViaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

describe("cantidadesNoMultiplo (pura, tabla de unidades del menu)", () => {
  it("4 tacos de bistec: orden de 3, opciones 3 y 6", () => {
    expect(cantidadesNoMultiplo("Hola, para recoger 4 tacos de bistec, tortilla de maíz")).toEqual([{ piezas: 4, producto: "tacos de bistec", piezasPorOrden: 3, opciones: [3, 6] }]);
  });
  it("3 gringas de pastor: orden de 2, opciones 2 y 4", () => {
    const r = cantidadesNoMultiplo("3 gringas de pastor de harina, todas las salsas. Pago en efectivo");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ piezas: 3, piezasPorOrden: 2, opciones: [2, 4] });
  });
  it("palabras y varios renglones", () => {
    expect(cantidadesNoMultiplo("cuatro tacos de chorizo y 5 mestizas de pastor").map((x) => x.piezas)).toEqual([4, 5]);
  });
  it.each([
    "6 tacos de bistec",
    "3 tacos de bistec",
    "4 tacos de pastor",
    "2 gringas de pastor",
    "quiero 4 tacos",
    "una orden de tacos de bistec",
    "2 kilos de bistec",
    "1 coca y 4 aguas",
  ])("%s no genera regla", (t) => {
    expect(cantidadesNoMultiplo(t)).toEqual([]);
    expect(bloqueCantidadNoMultiplo([t])).toBe("");
  });
});

describe("bloqueCantidadNoMultiplo", () => {
  it("tacos: explica la presentacion, opciones con piezas y ordenes, precio de la herramienta, sin precios escritos", () => {
    const b = bloqueCantidadNoMultiplo(["Hola, para recoger 4 tacos de bistec"]);
    expect(b).toMatch(/ordenes de 3 piezas/);
    expect(b).toMatch(/3 piezas \(1 orden\) o 6 piezas \(2 ordenes\)/);
    expect(b).toMatch(/PRECIO de cada una tomado de buscar_producto/);
    expect(b).not.toMatch(/\$\s*\d/);
    expect(b).not.toMatch(/ORDENES \(12 piezas\)/);
  });
  it("gringas: pregunta tambien si quiso 3 ORDENES (6 piezas)", () => {
    const b = bloqueCantidadNoMultiplo(["3 gringas de pastor de harina"]);
    expect(b).toMatch(/3 ORDENES \(6 piezas\)/);
    expect(b).toMatch(/2 piezas \(1 orden\) o 4 piezas \(2 ordenes\)/);
  });
  it("no repite el mismo renglon", () => {
    expect(bloqueCantidadNoMultiplo(["4 tacos de bistec", "si, 4 tacos de bistec"]).match(/El cliente pidio/g)).toHaveLength(1);
  });
});

describe("handler: el bloque llega al prompt del turno solo cuando aplica", () => {
  it("4 tacos de bistec: el system del modelo lleva la regla", async () => {
    const v = await nuevoViaje();
    v.guion([{ texto: "Los tacos de bistec se venden en órdenes de 3." }]);
    await v.escribe("Hola, para recoger 4 tacos de bistec, tortilla de maíz");
    expect(v.requests.length).toBeGreaterThan(0);
    expect(v.requests[0]!.system).toMatch(/REGLA DEL SERVIDOR PARA ESTE TURNO \(cantidad que no es multiplo/);
  });
  it("6 tacos de bistec: sin regla", async () => {
    const v = await nuevoViaje();
    v.guion([{ texto: "Con gusto." }]);
    await v.escribe("Hola, para recoger 6 tacos de bistec, tortilla de maíz");
    expect(v.requests[0]!.system).not.toMatch(/cantidad que no es multiplo/);
  });
});
