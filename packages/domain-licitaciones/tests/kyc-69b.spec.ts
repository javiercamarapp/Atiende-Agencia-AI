// L-08 -- piezas puras del KYC 69-B: validacion estricta del RFC, lote, semaforo y alerta.
import { describe, expect, it } from "vitest";
import {
  KYC_MAX_BATCH,
  KycValidationError,
  armarFichasResultado,
  clasificarSituacion,
  normalizeRfc,
  parseNombreFicha,
  parseRfc,
  parseRfcBatch,
  splitRfcText,
} from "../src/kyc-69b.ts";
import type { KycFicha } from "../src/kyc-69b.ts";

describe("parseRfc", () => {
  it("normaliza a mayusculas y recorta espacios", () => {
    expect(normalizeRfc("  pre850101ab1 ")).toBe("PRE850101AB1");
    expect(parseRfc("  pre850101ab1\n")).toEqual({ rfc: "PRE850101AB1", tipo: "moral" });
  });

  it("distingue persona moral (12) de fisica (13)", () => {
    expect(parseRfc("PRE850101AB1").tipo).toBe("moral");
    expect(parseRfc("FISI800101AB1").tipo).toBe("fisica");
  });

  it("acepta Ñ y & en las letras y A como digito verificador", () => {
    expect(parseRfc("Ñ&A850101AB1").tipo).toBe("moral");
    expect(parseRfc("PRE850101ABA").rfc).toBe("PRE850101ABA");
  });

  it("acepta el 29 de febrero (el RFC solo trae dos digitos de anio)", () => {
    expect(parseRfc("PRE880229AB1").rfc).toBe("PRE880229AB1");
  });

  it.each([
    ["longitud 11", "PRE85010AB1"],
    ["longitud 14", "FISIX800101AB1"],
    ["mes 13", "PRE851301AB1"],
    ["mes 00", "PRE850001AB1"],
    ["dia 32", "PRE850132AB1"],
    ["dia 00", "PRE850100AB1"],
    ["30 de febrero", "PRE850230AB1"],
    ["31 de abril", "PRE850431AB1"],
    ["digito verificador invalido", "PRE850101ABZ"],
    ["guion", "PRE-850101AB1"],
    ["numero donde van letras", "1RE850101AB1"],
    ["vacio", ""],
    ["solo espacios", "   "],
    ["inyeccion", "'; drop table x; --"],
  ])("rechaza %s", (_nombre, valor) => {
    expect(() => parseRfc(valor)).toThrow(KycValidationError);
  });

  it("rechaza los RFC genericos (publico en general y extranjero) con un mensaje claro", () => {
    expect(() => parseRfc("XAXX010101000")).toThrow(/generico/);
    expect(() => parseRfc("xexx010101000")).toThrow(/generico/);
  });

  it("rechaza lo que no es texto", () => {
    expect(() => parseRfc(123)).toThrow(KycValidationError);
    expect(() => parseRfc(null)).toThrow(KycValidationError);
  });
});

describe("parseRfcBatch", () => {
  it("quita duplicados (tras normalizar) conservando el orden", () => {
    expect(parseRfcBatch(["pre850101ab1", "DEF900202CD2", " PRE850101AB1 "])).toEqual(["PRE850101AB1", "DEF900202CD2"]);
  });

  it("aplica el tope sobre la entrada CRUDA: 51 duplicados tambien se rechazan", () => {
    expect(() => parseRfcBatch(Array.from({ length: KYC_MAX_BATCH + 1 }, () => "PRE850101AB1"))).toThrow(/Maximo 50/);
    expect(parseRfcBatch(Array.from({ length: KYC_MAX_BATCH }, () => "PRE850101AB1"))).toEqual(["PRE850101AB1"]);
  });

  it("un RFC invalido rechaza TODO el lote", () => {
    expect(() => parseRfcBatch(["PRE850101AB1", "xx"])).toThrow(KycValidationError);
  });

  it("rechaza vacio y no-arreglo", () => {
    expect(() => parseRfcBatch([])).toThrow(/al menos un RFC/);
    expect(() => parseRfcBatch("PRE850101AB1")).toThrow(KycValidationError);
    expect(() => parseRfcBatch(undefined)).toThrow(KycValidationError);
  });
});

describe("splitRfcText", () => {
  it("parte por comas, espacios, saltos de linea y punto y coma", () => {
    expect(splitRfcText("AAA010101AA1, BBB010101BB2;\nCCC010101CC3  \t DDD010101DD4,,")).toEqual(["AAA010101AA1", "BBB010101BB2", "CCC010101CC3", "DDD010101DD4"]);
    expect(splitRfcText("   ")).toEqual([]);
  });
});

describe("clasificarSituacion", () => {
  it("definitivo -> rojo accionable; presunto -> ambar accionable", () => {
    expect(clasificarSituacion("definitivo", true)).toMatchObject({ semaforo: "rojo", accionable: true });
    expect(clasificarSituacion("presunto", true)).toMatchObject({ semaforo: "ambar", accionable: true });
  });

  it("desvirtuado y sentencia favorable -> verde SIN alerta, con nota de antecedente", () => {
    for (const s of ["desvirtuado", "sentencia_favorable"] as const) {
      const r = clasificarSituacion(s, true);
      expect(r.semaforo).toBe("verde");
      expect(r.accionable).toBe(false);
      expect(r.detalle).toMatch(/antecedente/);
    }
  });

  it("no aparece -> verde pero aclara que no es constancia oficial", () => {
    const r = clasificarSituacion(null, true);
    expect(r.semaforo).toBe("verde");
    expect(r.detalle).toMatch(/no es una constancia oficial/i);
  });

  it("sin lista cargada -> sin_datos (nunca verde)", () => {
    expect(clasificarSituacion(null, false).semaforo).toBe("sin_datos");
    expect(clasificarSituacion("definitivo", false).semaforo).toBe("sin_datos");
  });
});

function ficha(partial: Partial<KycFicha>): KycFicha {
  return { id: "f", rfc: "PRE850101AB1", rol: "proveedor", nombre: "", creadaEn: "2026-10-01T00:00:00Z", periodo: "2024-06", encontrado: false, situacion: null, fechaPublicacion: null, ...partial };
}

describe("armarFichasResultado", () => {
  it("alerta solo a PROVEEDORES con situacion presunto o definitivo (no competidores, no desvirtuados)", () => {
    const r = armarFichasResultado([
      ficha({ id: "1", rol: "proveedor", situacion: "presunto", encontrado: true }),
      ficha({ id: "2", rol: "proveedor", situacion: "definitivo", encontrado: true }),
      ficha({ id: "3", rol: "competidor", situacion: "definitivo", encontrado: true }),
      ficha({ id: "4", rol: "proveedor", situacion: "desvirtuado", encontrado: true }),
      ficha({ id: "5", rol: "proveedor", situacion: null }),
    ]);
    expect(r.alertas.map((a) => a.id)).toEqual(["1", "2"]);
    expect(r.listaDisponible).toBe(true);
    expect(r.fichas.find((f) => f.id === "3")?.semaforo).toBe("rojo");
  });

  it("sin lista cargada no hay alertas ni semaforo afirmativo", () => {
    const r = armarFichasResultado([ficha({ periodo: null })]);
    expect(r.listaDisponible).toBe(false);
    expect(r.alertas).toEqual([]);
    expect(r.fichas[0]!.semaforo).toBe("sin_datos");
  });

  it("sin fichas: lista vacia", () => {
    expect(armarFichasResultado([])).toMatchObject({ fichas: [], alertas: [], listaDisponible: false });
  });
});

describe("parseNombreFicha", () => {
  it("colapsa espacios, acepta vacio y rechaza lo largo o no-texto", () => {
    expect(parseNombreFicha("  Acme   SA  ")).toBe("Acme SA");
    expect(parseNombreFicha(undefined)).toBe("");
    expect(() => parseNombreFicha("x".repeat(201))).toThrow(KycValidationError);
    expect(() => parseNombreFicha(5)).toThrow(KycValidationError);
  });
});
