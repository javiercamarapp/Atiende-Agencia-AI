// Tests de dominio de `text-similarity.ts`. `ratio`/`tokenSortRatio` se verificaron
// byte-exactos contra `rapidfuzz` real por separado (2,000 casos aleatorios, 0
// discrepancias — ver comentario de cabecera del archivo fuente y el golden-set de
// migración de catálogo, que depende de `tokenSortRatio` end-to-end). Aquí se fijan
// casos de referencia puntuales para detectar regresiones futuras sin depender de
// tener Python instalado en CI.
import { describe, expect, it } from "vitest";
import { ratio, tokenSortRatio, partialRatio, normalizarTexto, solapamientoTokens } from "../src/conciliacion/text-similarity.ts";

describe("ratio — similitud Indel exacta", () => {
  it("cadenas idénticas -> 100", () => expect(ratio("hola mundo", "hola mundo")).toBe(100));
  it("ambas vacías -> 100", () => expect(ratio("", "")).toBe(100));
  it("sin caracteres en común -> 0", () => expect(ratio("abc", "xyz")).toBe(0));
  it("caso de referencia fijado contra rapidfuzz real: ratio(' 2c','bc')=40", () => expect(ratio(" 2c", "bc")).toBe(40));
});

describe("tokenSortRatio — insensible al orden de palabras", () => {
  it("mismas palabras, orden distinto -> 100", () => {
    expect(tokenSortRatio("cuentas bancos", "bancos cuentas")).toBe(100);
  });
  it("caso de referencia fijado contra rapidfuzz real: 'caja general' vs 'general caja' -> 100", () => {
    expect(tokenSortRatio("caja general", "general caja")).toBe(100);
  });
});

describe("partialRatio — aproximación documentada (ver cabecera del archivo)", () => {
  it("substring exacto embebido -> 100", () => {
    expect(partialRatio("factura", "pago de factura número 5")).toBe(100);
  });
  it("sin relación -> score bajo", () => {
    expect(partialRatio("zzzzz", "abcde")).toBeLessThan(50);
  });
});

describe("normalizarTexto", () => {
  it("minúsculas, colapsa espacios, quita signos", () => {
    expect(normalizarTexto("  Pago  DE!! Factura#123  ")).toBe("pago de factura 123");
  });
  it("preserva acentos/ñ (a diferencia del normalizador de catálogo, que sí los quita)", () => {
    expect(normalizarTexto("Depósito Niño")).toBe("depósito niño");
  });
});

describe("solapamientoTokens", () => {
  it("mitad de tokens en común -> 0.5", () => {
    expect(solapamientoTokens("a b c d", "a b x y")).toBe(2 / 4);
  });
  it("conjunto vacío -> 0", () => {
    expect(solapamientoTokens("", "algo")).toBe(0);
  });
});
