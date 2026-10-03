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
