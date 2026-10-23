// paridad3 L-P3-14: la huella TypeScript coincide con la de SQL (mismos vectores dorados que scripts/verify-licitaciones-dedupe-y-paginacion).
import { describe, expect, it } from "vitest";
import { computeCrossSourceFingerprint, mexicoCityDate, normalizeTenderText } from "../src/cross-source-fingerprint.ts";

const BASE = { procedureNumber: "LA-931037999-E12-2026", contractingBody: "Secretaría de Obras Públicas", submissionDeadline: "2026-10-20T17:00:00-06:00" };

describe("computeCrossSourceFingerprint", () => {
  it("vectores dorados: iguales a los de la funcion SQL licitaciones.tender_fingerprint", () => {
    expect(computeCrossSourceFingerprint(BASE)).toBe("8eaf2712199c939030644cdd295a2467cff146587baa0ac51522b4fa03a7d842");
    expect(computeCrossSourceFingerprint({ procedureNumber: "NÚM 7/2026", contractingBody: "Ayuntamiento de Mérida", submissionDeadline: "2026-11-02T09:00:00-06:00" })).toBe(
      "7df4e7484fa6efc6820640fbcb20028fc25f6c708acb1ae68184e6893964a1bf",
    );
  });

  it("la misma convocatoria con otro formato (mayusculas, espacios, acentos, NFD, otra hora del mismo dia) da la MISMA huella", () => {
    const base = computeCrossSourceFingerprint(BASE);
    expect(computeCrossSourceFingerprint({ procedureNumber: "  la-931037999-e12-2026 ", contractingBody: "SECRETARIA   DE OBRAS PUBLICAS", submissionDeadline: "2026-10-20T10:00:00-06:00" })).toBe(base);
    expect(computeCrossSourceFingerprint({ ...BASE, contractingBody: "Secretaría de Obras Públicas" })).toBe(base);
  });

  it("procedimiento o convocante distintos dan huellas distintas", () => {
    const base = computeCrossSourceFingerprint(BASE);
    expect(computeCrossSourceFingerprint({ ...BASE, procedureNumber: "LA-931037999-E13-2026" })).not.toBe(base);
    expect(computeCrossSourceFingerprint({ ...BASE, contractingBody: "Otra convocante" })).not.toBe(base);
  });

  it("la fecha es la de Mexico: 21 oct 03:00 UTC sigue siendo 20 oct; 21 oct 07:00 UTC ya es 21 oct", () => {
    const a = computeCrossSourceFingerprint({ procedureNumber: "P-1", contractingBody: "IMSS", submissionDeadline: "2026-10-20T17:00:00-06:00" });
    expect(computeCrossSourceFingerprint({ procedureNumber: "P-1", contractingBody: "IMSS", submissionDeadline: "2026-10-21T03:00:00Z" })).toBe(a);
    expect(computeCrossSourceFingerprint({ procedureNumber: "P-1", contractingBody: "IMSS", submissionDeadline: "2026-10-21T07:00:00Z" })).not.toBe(a);
    expect(mexicoCityDate("2026-10-21T03:00:00Z")).toBe("2026-10-20");
  });

  it("sin procedimiento, convocante o plazo no hay huella (no se fusiona a ciegas)", () => {
    expect(computeCrossSourceFingerprint({ ...BASE, procedureNumber: null })).toBeNull();
    expect(computeCrossSourceFingerprint({ ...BASE, contractingBody: "   " })).toBeNull();
    expect(computeCrossSourceFingerprint({ ...BASE, submissionDeadline: null })).toBeNull();
  });

  it("normalizeTenderText: NFC/NFD, mayusculas y espacios", () => {
    expect(normalizeTenderText("  Núm   7/2026 ")).toBe("NUM 7/2026");
    expect(normalizeTenderText("   ")).toBeNull();
  });
});
