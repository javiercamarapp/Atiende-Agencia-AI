// Primitivas puras del login por celular: normalizacion E.164, codigo aleatorio, hash con sal, comparacion en tiempo constante.
import { describe, expect, it } from "vitest";
import { CODIGO_DIGITOS, derivarLlave, generarCodigo, generarSal, hashCodigo, iguales, normalizarCodigoIngresado, pseudonimo } from "../src/login-telefono/codigo.ts";
import { normalizarTelefonoMx } from "../src/login-telefono/telefono.ts";

describe("normalizarTelefonoMx", () => {
  it("acepta las formas reales y devuelve +52 + 10 digitos", () => {
    for (const forma of ["9991230001", "+529991230001", "529991230001", "5219991230001", "(999) 123-0001", "+52 999 123 0001", " 999.123.0001 "]) {
      expect(normalizarTelefonoMx(forma), forma).toBe("+529991230001");
    }
  });
  it("rechaza longitudes, prefijos y caracteres invalidos (nunca recorta a la fuerza)", () => {
    for (const malo of ["", "123", "99912300011", "+15551234567", "0991230001", "99912300a1", "+52 999 123", null, undefined, 9991230001, "9".repeat(40)]) {
      expect(normalizarTelefonoMx(malo), String(malo)).toBeNull();
    }
  });
});

describe("codigo", () => {
  it("siempre 6 digitos con ceros a la izquierda, con la entropia inyectada", () => {
    expect(generarCodigo(() => 0)).toBe("000000");
    expect(generarCodigo(() => 42)).toBe("000042");
    expect(generarCodigo(() => 999_999)).toBe("999999");
    expect(generarCodigo()).toMatch(new RegExp(`^\\d{${CODIGO_DIGITOS}}$`));
  });
  it("pide el rango completo [0, 10^6) a la fuente aleatoria (sin sesgo de modulo)", () => {
    let visto = 0;
    generarCodigo((n) => ((visto = n), 0));
    expect(visto).toBe(1_000_000);
  });
  it("la sal es de 32 hex y distinta cada vez", () => {
    const a = generarSal();
    const b = generarSal();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
  it("hash determinista por (llave, sal, codigo) y distinto si cambia cualquiera", () => {
    const k1 = derivarLlave("secreto-1");
    const k2 = derivarLlave("secreto-2");
    const base = hashCodigo(k1, "a".repeat(32), "123456");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCodigo(k1, "a".repeat(32), "123456")).toBe(base);
    expect(hashCodigo(k2, "a".repeat(32), "123456")).not.toBe(base);
    expect(hashCodigo(k1, "b".repeat(32), "123456")).not.toBe(base);
    expect(hashCodigo(k1, "a".repeat(32), "123457")).not.toBe(base);
    expect(base).not.toContain("123456");
  });
  it("pseudonimo separa dominios (tel vs ip) y no revela el valor", () => {
    const k = derivarLlave("s");
    expect(pseudonimo(k, "tel", "+529991230001")).not.toBe(pseudonimo(k, "ip", "+529991230001"));
    expect(pseudonimo(k, "tel", "+529991230001")).not.toContain("9991230001");
  });
  it("iguales: igualdad exacta; longitudes distintas -> false sin lanzar", () => {
    expect(iguales("abc", "abc")).toBe(true);
    expect(iguales("abc", "abd")).toBe(false);
    expect(iguales("abc", "abcd")).toBe(false);
    expect(iguales("", "")).toBe(true);
  });
  it("normalizarCodigoIngresado: 6 digitos, tolera espacios intermedios", () => {
    expect(normalizarCodigoIngresado("123456")).toBe("123456");
    expect(normalizarCodigoIngresado(" 123 456 ")).toBe("123456");
    for (const malo of ["12345", "1234567", "12345a", "", null, 123456, "1".repeat(30)]) expect(normalizarCodigoIngresado(malo)).toBeNull();
  });
});
