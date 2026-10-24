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
  it("falsos negativos: sin «de» y cantidad al final", () => {
    expect(cantidadesNoMultiplo("quiero 4 tacos bistec").map((x) => x.piezas)).toEqual([4]);
    expect(cantidadesNoMultiplo("tacos de bistec 4").map((x) => x.piezas)).toEqual([4]);
    expect(cantidadesNoMultiplo("tacos de bistec 4 pesos")).toEqual([]);
  });
  it("una clausula pasada no tapa un pedido nuevo en otra clausula", () => {
    expect(cantidadesNoMultiplo("ayer pedi 6 tacos de bistec, ahora quiero 4 tacos de bistec").map((x) => x.piezas)).toEqual([4]);
  });
  it("palabras y varios renglones", () => {
    expect(cantidadesNoMultiplo("cuatro tacos de chorizo y 5 mestizas de pastor").map((x) => x.piezas)).toEqual([4, 5]);
  });
  it.each([
    "ordené 4 tacos de bistec y me llegaron 3",
    "hace 4 años pedí 3 gringas de pastor",
    "ya no quiero 4 tacos de bistec, mejor 6",
    "me llegaron 4 tacos de bistec y quiero reembolso",
    "cancela los 4 tacos de bistec",
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
    expect(b).toMatch(/Si el cliente esta pidiendo ahora 4 tacos de bistec/);
    expect(b).toMatch(/ordenes de 3 piezas/);
    expect(b).toMatch(/otro pack_size.*manda la herramienta/);
    expect(b).toMatch(/reclama, corrige o cancela/);
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
    expect(bloqueCantidadNoMultiplo(["4 tacos de bistec", "si, 4 tacos de bistec"]).match(/esta pidiendo ahora/g)).toHaveLength(1);
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
