// Layout DIOT (TXT/XML): reglas de captura, redondeo a pesos enteros, tipo de
// tercero/operación y casos de borde. Puro, sin I/O.
import { describe, expect, it } from "vitest";
import { COLUMNAS_DIOT, DiotLayoutError, construirDiotLayout, esRfcValidoDiot, generarDiotTxt, redondearPesos } from "../src/declaraciones/diot-layout.ts";
import { candidatosDiotDesdeInvoices } from "../src/declaraciones/diot-desde-invoices.ts";
import type { RegistroDiotCandidato } from "../src/declaraciones/types.ts";

function cand(o: Partial<RegistroDiotCandidato> = {}): RegistroDiotCandidato {
  return { rfcEmisor: "CON950820K12", nombreEmisor: "PROVEEDOR SA", subtotal: 1000, ivaTrasladado: 160, ivaAcreditable: 160, tasaIva: 0.16, tipoCambio: 1, moneda: "MXN", fecha: "2026-07-01", ...o };
}
const DECLARANTE = "AAA010101AAA";

describe("redondearPesos", () => {
  it("mitad hacia arriba sobre centavos enteros", () => {
    expect(redondearPesos(12349)).toBe(123);
    expect(redondearPesos(12350)).toBe(124);
    expect(redondearPesos(49)).toBe(0);
    expect(redondearPesos(50)).toBe(1);
  });
});

describe("esRfcValidoDiot", () => {
  it("acepta moral (12), física (13), con Ñ y &", () => {
    expect(esRfcValidoDiot("CON950820K12")).toBe(true);
    expect(esRfcValidoDiot("PEPJ800101AB3")).toBe(true);
    expect(esRfcValidoDiot("ÑAN800101AB3")).toBe(true);
    expect(esRfcValidoDiot("&AN800101AB3")).toBe(true);
  });
  it("rechaza longitud/fecha/caracteres inválidos", () => {
    expect(esRfcValidoDiot("")).toBe(false);
    expect(esRfcValidoDiot("CON950820K1")).toBe(false);
    expect(esRfcValidoDiot("CON95082OK12")).toBe(false);
    expect(esRfcValidoDiot("con950820k12")).toBe(false);
  });
});

describe("construirDiotLayout — TXT", () => {
  it("un proveedor nacional al 16%: tipo 04, operación 85 por defecto, base en pesos enteros, 18 campos", () => {
    const l = construirDiotLayout([cand({ subtotal: 1234.56 })], DECLARANTE, "2026-07");
    expect(l.renglones).toHaveLength(1);
    const lineas = l.txt.split("\r\n");
    expect(lineas[1]).toBe("");
    const campos = lineas[0]!.split("|");
    expect(campos).toHaveLength(COLUMNAS_DIOT.length);
    expect(campos[0]).toBe("04");
    expect(campos[1]).toBe("85");
    expect(campos[2]).toBe("CON950820K12");
    expect(campos[7]).toBe("1235"); // 1234.56 -> 1235
    expect(campos.slice(3, 7)).toEqual(["", "", "", ""]);
  });

  it("tipo de operación explícita (03/06) se respeta y NUNCA se deriva de la tasa", () => {
    const l = construirDiotLayout([cand({ tipoOperacion: "06", tasaIva: 0, ivaTrasladado: 0, ivaAcreditable: 0 }), cand({ rfcEmisor: "BBB010101BB1", tipoOperacion: "03", tasaIva: 0, ivaTrasladado: 0, ivaAcreditable: 0 })], DECLARANTE, "2026-07");
    expect(l.renglones.map((r) => [r.rfc, r.tipoOperacion])).toEqual([["BBB010101BB1", "03"], ["CON950820K12", "06"]]);
  });

  it("separa por tasa: 16%, 8% frontera, 0% y exento van a su columna", () => {
    const l = construirDiotLayout(
      [cand({ subtotal: 100 }), cand({ subtotal: 200, tasaIva: 0.08, ivaTrasladado: 16 }), cand({ subtotal: 300, tasaIva: 0, ivaTrasladado: 0 }), cand({ subtotal: 400, tasaIva: 0.04, ivaTrasladado: 16 })],
      DECLARANTE,
      "2026-07",
    );
    const r = l.renglones[0]!;
    expect([r.valorActos16, r.valorActos8, r.valorActos0, r.valorExentos]).toEqual([100, 200, 300, 400]);
    const campos = l.txt.split("\r\n")[0]!.split("|");
    expect([campos[7], campos[8], campos[14], campos[15]]).toEqual(["100", "200", "300", "400"]);
  });

  it("agrupa varios CFDI del mismo (RFC, operación) y redondea UNA vez por celda", () => {
    // 3 x 0.40 = 1.20 -> 1 peso (no 3 x round(0.40)=0)
    const l = construirDiotLayout([cand({ subtotal: 0.4 }), cand({ subtotal: 0.4 }), cand({ subtotal: 0.4 })], DECLARANTE, "2026-07");
    expect(l.renglones).toHaveLength(1);
    expect(l.renglones[0]!.valorActos16).toBe(1);
  });

  it("convierte moneda extranjera a MXN antes de redondear (USD 100.10 x 17.3 = 1731.73)", () => {
    const l = construirDiotLayout([cand({ subtotal: 100.1, tipoCambio: 17.3, moneda: "USD" })], DECLARANTE, "2026-07");
    expect(l.renglones[0]!.valorActos16).toBe(1732);
  });

  it("omite RFC genérico y RFC inválido y lo reporta, sin capturarlos", () => {
    const l = construirDiotLayout([cand({ rfcEmisor: "XAXX010101000" }), cand({ rfcEmisor: "MAL" }), cand()], DECLARANTE, "2026-07");
    expect(l.renglones.map((r) => r.rfc)).toEqual(["CON950820K12"]);
    expect(l.omitidos).toEqual([
      { rfc: "XAXX010101000", motivo: "rfc_generico" },
      { rfc: "MAL", motivo: "rfc_invalido" },
    ]);
    expect(l.advertencias.join(" ")).toMatch(/genérico/);
  });

  it("omite renglón cuyo valor redondea a 0 (centavos sueltos) y avisa archivo vacío", () => {
    const l = construirDiotLayout([cand({ subtotal: 0.3 })], DECLARANTE, "2026-07");
    expect(l.renglones).toHaveLength(0);
    expect(l.txt).toBe("");
    expect(l.omitidos).toEqual([{ rfc: "CON950820K12", motivo: "sin_valor_tras_redondeo" }]);
    expect(l.advertencias[0]).toMatch(/no contiene renglones/);
  });

  it("salida determinista: ordena por RFC y operación sin importar el orden de entrada", () => {
    const a = construirDiotLayout([cand({ rfcEmisor: "ZZZ010101ZZ1" }), cand({ rfcEmisor: "AAA010101AA1" })], DECLARANTE, "2026-07");
    const b = construirDiotLayout([cand({ rfcEmisor: "AAA010101AA1" }), cand({ rfcEmisor: "ZZZ010101ZZ1" })], DECLARANTE, "2026-07");
    expect(a.txt).toBe(b.txt);
    expect(a.renglones[0]!.rfc).toBe("AAA010101AA1");
  });

  it("monto grande en MXN sin notación científica", () => {
    const l = construirDiotLayout([cand({ subtotal: 123456789012.34 })], DECLARANTE, "2026-07");
    expect(l.txt.split("|")[7]).toBe("123456789012");
  });

  it("generarDiotTxt vacío es cadena vacía", () => {
    expect(generarDiotTxt([])).toBe("");
  });
});

describe("construirDiotLayout — validación de entrada", () => {
  it("rechaza periodo mal formado y RFC de contribuyente inválido", () => {
    expect(() => construirDiotLayout([], DECLARANTE, "2026-13")).toThrow(DiotLayoutError);
    expect(() => construirDiotLayout([], DECLARANTE, "202607")).toThrow(DiotLayoutError);
    expect(() => construirDiotLayout([], "XX", "2026-07")).toThrow(DiotLayoutError);
  });
});

describe("construirDiotLayout — XML", () => {
  it("emite XML sin firmar con los mismos campos, omite vacíos y escapa caracteres", () => {
    const l = construirDiotLayout([cand({ rfcEmisor: "&AN800101AB3", subtotal: 1000 })], "AAA010101AAA", "2026-07");
    expect(l.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(l.xml).toContain('firmado="false"');
    expect(l.xml).toContain('ejercicio="2026" periodo="07"');
    expect(l.xml).toContain("<RFC>&amp;AN800101AB3</RFC>");
    expect(l.xml).toContain("<ValorActos16>1000</ValorActos16>");
    expect(l.xml).not.toContain("NumIdFiscal");
    expect(l.xml).not.toContain("ValorActos8");
  });

  it("sin renglones deja Terceros vacío y bien formado", () => {
    const l = construirDiotLayout([], DECLARANTE, "2026-07");
    expect(l.xml).toContain("<Terceros>\n  </Terceros>");
  });
});

describe("candidatosDiotDesdeInvoices", () => {
  it("sin invoices reportables: sin candidatos ni RFC de contribuyente", () => {
    expect(candidatosDiotDesdeInvoices([], null)).toEqual({ candidatos: [], rfcContribuyente: null, excluidos: 0 });
  });
});
