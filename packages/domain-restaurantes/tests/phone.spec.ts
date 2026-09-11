import { describe, expect, it } from "vitest";
import { canonicalizeMexicanPhone, normalizePhone } from "../src/phone.ts";

describe("normalizePhone", () => {
  it("normaliza a los últimos 10 dígitos, absorbiendo +52/521/espacios/guiones", () => {
    expect(normalizePhone("+52 999 123 4567")).toBe("9991234567");
    expect(normalizePhone("521-999-123-4567")).toBe("9991234567");
    expect(normalizePhone("9991234567")).toBe("9991234567");
  });

  it("el mismo cliente real en formatos distintos normaliza al mismo valor (bug real 3-sep-2026)", () => {
    const formatoVoz = normalizePhone("999 123 45 67");
    const formatoWhatsApp = normalizePhone("529991234567");
    const formatoWeb = normalizePhone("+52-999-123-4567");
    expect(formatoVoz).toBe(formatoWhatsApp);
    expect(formatoWhatsApp).toBe(formatoWeb);
  });

  it("un identificador sin dígitos reales suficientes NO colapsa a un fragmento compartido (bug real 3-sep-2026)", () => {
    const a = normalizePhone("widget-sin-numeros");
    const b = normalizePhone("01");
    expect(a).not.toBe(b);
    expect(a).toBe("widget-sin-numeros");
    expect(b).toBe("01");
  });
});

describe("canonicalizeMexicanPhone", () => {
  it("acepta 10 dígitos nacionales tal cual", () => {
    expect(canonicalizeMexicanPhone("9991234567")).toBe("9991234567");
  });

  it("acepta 52+10 dígitos y 521+10 dígitos, recortando el prefijo de país", () => {
    expect(canonicalizeMexicanPhone("529991234567")).toBe("9991234567");
    expect(canonicalizeMexicanPhone("5219991234567")).toBe("9991234567");
  });

  it("rechaza cualquier otra longitud en vez de recortar dígitos arbitrarios", () => {
    expect(canonicalizeMexicanPhone("99912345")).toBeNull();
    expect(canonicalizeMexicanPhone("99991234567890")).toBeNull();
  });
});
