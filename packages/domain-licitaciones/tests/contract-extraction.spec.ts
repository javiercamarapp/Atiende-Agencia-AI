import { describe, expect, it } from "vitest";
import { extractContractFields, CONTRACT_FIELD_KEYS } from "../src/contract-extraction.ts";

describe("contract-extraction.ts -- extracción determinista (sin LLM) del contrato firmado (REQ-052)", () => {
  it("sin páginas -- arreglo vacío, nunca inventa nada", () => {
    expect(extractContractFields([])).toEqual([]);
  });

  it("detecta número de contrato, monto total y plazo de entrega con página y confianza explícitos", () => {
    const fields = extractContractFields([
      {
        page: 1,
        text: "CLÁUSULA PRIMERA. Objeto.\nContrato número: SABG-2026-001.\nMonto total $1,250,000.00 (un millón doscientos cincuenta mil pesos 00/100 M.N.).",
      },
      { page: 2, text: "CLÁUSULA CUARTA. Plazo de entrega será de 30 días naturales contados a partir de la firma." },
    ]);

    const numero = fields.find((f) => f.fieldKey === "numero_contrato");
    expect(numero?.value).toContain("SABG-2026-001");
    expect(numero?.sourcePage).toBe(1);
    expect(numero?.sourceClause).toBe("Cláusula PRIMERA");
    expect(numero?.confidence).toBeGreaterThan(0);

    const monto = fields.find((f) => f.fieldKey === "monto_total");
    expect(monto?.value).toContain("1,250,000.00");
    expect(monto?.sourcePage).toBe(1);

    const plazo = fields.find((f) => f.fieldKey === "plazo_entrega");
    expect(plazo?.sourcePage).toBe(2);
    expect(plazo?.sourceClause).toBe("Cláusula CUARTA");
  });

  it("un campo ausente en el texto simplemente no aparece -- nunca se inventa", () => {
    const fields = extractContractFields([{ page: 1, text: "Este documento no menciona ninguno de los temas buscados." }]);
    expect(fields).toEqual([]);
  });

  it("cada campo detectado usa una de las 9 claves cerradas del catálogo", () => {
    const fields = extractContractFields([
      {
        page: 1,
        text:
          "Contrato número ABC-123. Monto total $500.00. Plazo de entrega de 10 días. Garantía de cumplimiento del 10%. Pena convencional del 1% diario. " +
          "Deductiva aplicable por incumplimiento. Forma de pago: transferencia electrónica. Administrador del contrato: Juan Pérez. " +
          "Cesión de derechos de cobro autorizada por la convocante.",
      },
    ]);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(CONTRACT_FIELD_KEYS).toContain(f.fieldKey);
  });

  it("recorta valores largos a maxValueLength con elipsis", () => {
    // Ventana de captura (220) + prefijo ("cesión de derechos de cobro ") supera
    // maxValueLength (240) para este campo -- dispara el recorte.
    const longClause = `cesión de derechos de cobro${"x".repeat(220)}.`;
    const fields = extractContractFields([{ page: 1, text: longClause }]);
    const cesion = fields.find((f) => f.fieldKey === "cesion_cobro");
    expect(cesion?.value.endsWith("…")).toBe(true);
    expect(cesion!.value.length).toBeLessThan(longClause.length);
  });

  it("sin ninguna 'CLÁUSULA' antes de la coincidencia -- sourceClause es null (nunca inventado)", () => {
    const fields = extractContractFields([{ page: 1, text: "Monto total $100.00 sin ninguna cláusula declarada antes." }]);
    const monto = fields.find((f) => f.fieldKey === "monto_total");
    expect(monto?.sourceClause).toBeNull();
  });
});
