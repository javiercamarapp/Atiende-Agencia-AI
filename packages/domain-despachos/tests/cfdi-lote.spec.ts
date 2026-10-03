// D-13: piezas puras de la carga masiva de CFDI (totales, nombres, enrutado por TipoDeComprobante).
import { describe, expect, it } from "vitest";
import { MAX_ARCHIVOS_LOTE, nombreArchivoParaMostrar, sumarTotalesLote, tipoComprobanteDeXml, totalesDeLote } from "../src/index.ts";
import type { ResultadoArchivoLote } from "../src/index.ts";

const r = (estado: ResultadoArchivoLote["estado"], clase: ResultadoArchivoLote["clase"] = "cfdi"): ResultadoArchivoLote => ({ archivo: "a.xml", estado, clase, folioFiscal: null, motivo: null });

describe("totalesDeLote", () => {
  it("cuenta cada estado una sola vez y los REP aparte", () => {
    const t = totalesDeLote([r("ingerido"), r("ingerido"), r("en_revision"), r("duplicado"), r("rechazado", null), r("ingerido", "rep")]);
    expect(t).toEqual({ recibidos: 6, ingeridos: 3, enRevision: 1, duplicados: 1, rechazados: 1, reps: 1 });
  });
  it("lote vacio = todo en cero", () => {
    expect(totalesDeLote([])).toEqual({ recibidos: 0, ingeridos: 0, enRevision: 0, duplicados: 0, rechazados: 0, reps: 0 });
  });
  it("sumarTotalesLote suma tandas", () => {
    const a = totalesDeLote([r("ingerido"), r("rechazado", null)]);
    const b = totalesDeLote([r("duplicado"), r("ingerido", "rep")]);
    expect(sumarTotalesLote([a, b])).toEqual({ recibidos: 4, ingeridos: 2, enRevision: 0, duplicados: 1, rechazados: 1, reps: 1 });
  });
  it("el tope por peticion es 50", () => expect(MAX_ARCHIVOS_LOTE).toBe(50));
});

describe("nombreArchivoParaMostrar", () => {
  it("quita la ruta, los caracteres de control y trunca", () => {
    expect(nombreArchivoParaMostrar("carpeta/sub\\a\u0007b.xml")).toBe("ab.xml");
    expect(nombreArchivoParaMostrar("x".repeat(300)).length).toBe(120);
    expect(nombreArchivoParaMostrar("///")).toBe("(sin nombre)");
  });
});

describe("tipoComprobanteDeXml", () => {
  const raiz = (attrs: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!-- c -->\n<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" ${attrs}><cfdi:Emisor TipoDeComprobante="N"/></cfdi:Comprobante>`;
  it("lee el atributo de la raiz sin importar el orden ni el prefijo", () => {
    expect(tipoComprobanteDeXml(raiz('Version="4.0" TipoDeComprobante="P" Total="0"'))).toBe("P");
    expect(tipoComprobanteDeXml(raiz("TipoDeComprobante='n'"))).toBe("N");
    expect(tipoComprobanteDeXml('<Comprobante TipoDeComprobante="I"/>')).toBe("I");
  });
  it("no se deja engañar por un atributo del mismo nombre en un hijo, ni por texto que no es XML", () => {
    expect(tipoComprobanteDeXml(raiz('Version="4.0"'))).toBeNull();
    expect(tipoComprobanteDeXml("hola")).toBeNull();
  });
});

describe("tipoComprobanteDeXml — casos limite y entrada hostil", () => {
  it("BOM, espacios, atributos con apostrofes, auto-cierre y comentarios/declaraciones previas", () => {
    expect(tipoComprobanteDeXml('﻿  \n<?xml version="1.0"?>\n<!-- a --><!-- b -->\n<cfdi:Comprobante Version = "4.0"\n TipoDeComprobante = \'p\' />')).toBe("P");
  });
  it("el nodo raiz debe ser Comprobante; DOCTYPE antes de la raiz o etiqueta sin cerrar -> null", () => {
    expect(tipoComprobanteDeXml('<Otro TipoDeComprobante="I"/>')).toBeNull();
    expect(tipoComprobanteDeXml('<!DOCTYPE x><cfdi:Comprobante TipoDeComprobante="I"/>')).toBeNull();
    expect(tipoComprobanteDeXml('<cfdi:Comprobante TipoDeComprobante="I')).toBeNull();
    expect(tipoComprobanteDeXml("")).toBeNull();
  });
  it("repeticiones masivas de '<!--' y '<?xml' se resuelven en tiempo lineal (sin backtracking)", () => {
    const t0 = Date.now();
    expect(tipoComprobanteDeXml("<!--".repeat(200_000))).toBeNull();
    expect(tipoComprobanteDeXml("<?xml".repeat(200_000))).toBeNull();
    expect(tipoComprobanteDeXml(`${"<!---->".repeat(100_000)}<Comprobante TipoDeComprobante="N"/>`)).toBe("N");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
