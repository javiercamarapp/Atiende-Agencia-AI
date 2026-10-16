// QA-restaurantes-R1-agentes-13: parser de importes hablados y grader G_PRECIO_HABLADO.
import { describe, expect, it } from "vitest";
import { G_PRECIO_HABLADO, importesHablados, numeroEnPalabras, numerosDe } from "../src/simulador/index.ts";
import type { LlamadaGradeable } from "../src/simulador/index.ts";

describe("importesHablados", () => {
  it("cifras en palabras pegadas a 'pesos'", () => {
    expect(importesHablados("Son trescientos veintiocho pesos.")).toEqual([328]);
    expect(importesHablados("cuatrocientos noventa y dos pesos")).toEqual([492]);
    expect(importesHablados("Cuatro mil novecientos veinte pesos")).toEqual([4920]);
    expect(importesHablados("mil doscientos pesos")).toEqual([1200]);
    expect(importesHablados("un peso")).toEqual([1]);
    expect(importesHablados("ciento sesenta y cuatro pesos y doscientos pesos de minimo")).toEqual([164, 200]);
    expect(importesHablados("veinticinco pesos")).toEqual([25]);
  });
  it("cifras en digitos con $ o con 'pesos'", () => {
    expect(importesHablados("Son $328.")).toEqual([328]);
    expect(importesHablados("son 1,234.50 pesos")).toEqual([1234.5]);
    expect(importesHablados("$ 95 y 40 pesos")).toEqual([95, 40]);
  });
  it("no confunde cantidades, horas ni numeros de calle con dinero", () => {
    expect(importesHablados("Son seis tacos para las ocho, calle sesenta numero cien")).toEqual([]);
    expect(importesHablados("Son dos ordenes de tres tacos")).toEqual([]);
  });
  it("numeroEnPalabras rechaza lo que no es cifra", () => {
    expect(numeroEnPalabras(["hola"])).toBeNull();
    expect(numeroEnPalabras([])).toBeNull();
  });
  it("numerosDe junta los numeros de cualquier profundidad", () => {
    expect(numerosDe({ quote: { total: 328, items: [{ price: 164 }] }, ok: true })).toEqual([328, 164]);
  });
});

function llamada(dice: string, resultado: unknown): LlamadaGradeable {
  return { tools: [{ nombre: "cotizar_pedido", args: {}, resultado }], transcripcion: [{ rol: "agente", texto: dice }] } as unknown as LlamadaGradeable;
}

describe("G_PRECIO_HABLADO", () => {
  it("pasa cuando el importe dicho es el cotizado, y marca el distinto", async () => {
    expect((await G_PRECIO_HABLADO(llamada("Son trescientos veintiocho pesos.", { quote: { total: 328 } }))).ok).toBe(true);
    const r = await G_PRECIO_HABLADO(llamada("Son doscientos pesos.", { quote: { total: 328 } }));
    expect(r.ok).toBe(false);
    expect(r.detalle).toMatch(/200/);
  });
  it("acepta la parte entera de un importe con centavos y no revisa lo que dice el cliente", async () => {
    expect((await G_PRECIO_HABLADO(llamada("Son ciento sesenta y cuatro pesos con cincuenta centavos.", { quote: { total: 164.5 } }))).ok).toBe(true);
    const l = { tools: [], transcripcion: [{ rol: "cliente", texto: "pago con quinientos pesos" }] } as unknown as LlamadaGradeable;
    expect((await G_PRECIO_HABLADO(l)).ok).toBe(true);
  });
});
