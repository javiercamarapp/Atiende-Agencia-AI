// Flujo 1 — REQ-LIC-002/003/004: las 7 dimensiones del checklist de
// integridad, cada una con su propio criterio de bloqueo real.
import { describe, expect, it } from "vitest";
import { IntegrityChecklist } from "../src/integrity-checklist.ts";
import type { IntegrityChecklistInput } from "../src/integrity-checklist.ts";
import type { CompanyDocument } from "../src/company-data.ts";

function baseInput(overrides: Partial<IntegrityChecklistInput> = {}): IntegrityChecklistInput {
  return {
    files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 1000 }],
    formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
    requiredSignatures: [],
    requiredAnnexes: [],
    presentAnnexRefs: [],
    documentsToValidate: [],
    economicResult: { lineItems: [], blockedLineItems: [], totals: { currency: "MXN", subtotal: "100.00", ivaRate: 0.16, iva: "16.00", total: "116.00", totalInWords: "SON: CIENTO DIECISÉIS PESOS 00/100 M.N." }, cartaText: "x", anexoText: "y" },
    crossDocumentTotals: [
      { documentLabel: "carta", total: "116.00" },
      { documentLabel: "anexo", total: "116.00" },
    ],
    ...overrides,
  };
}

describe("IntegrityChecklist -- overallStatus", () => {
  it("todo verde cuando no hay problemas en ninguna dimensión", () => {
    const report = new IntegrityChecklist().run(baseInput());
    expect(report.overallStatus).toBe("verde");
    expect(report.items).toHaveLength(7);
  });

  it("un solo rojo domina el overallStatus, sin importar cuántos verdes haya", () => {
    const report = new IntegrityChecklist().run(baseInput({ files: [{ filename: "malware.exe", extension: "exe", sizeBytes: 10 }] }));
    expect(report.overallStatus).toBe("rojo");
  });
});

describe("checkFormatos / checkLimites", () => {
  it("rechaza una extensión no permitida", () => {
    const report = new IntegrityChecklist().run(baseInput({ files: [{ filename: "foto.png", extension: "png", sizeBytes: 10 }] }));
    expect(report.items.find((i) => i.dimension === "formatos")!.status).toBe("rojo");
  });

  it("rechaza un archivo que excede el tamaño máximo o los slots de carga del portal", () => {
    const report = new IntegrityChecklist().run(baseInput({ files: [{ filename: "carta.pdf", extension: "pdf", sizeBytes: 99_999_999 }] }));
    expect(report.items.find((i) => i.dimension === "limites")!.status).toBe("rojo");
  });
});

describe("checkFirmas -- el sistema nunca firma ni simula firma", () => {
  it("una firma no confirmada por el usuario bloquea la dimensión", () => {
    const report = new IntegrityChecklist().run(baseInput({ requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: false }] }));
    const item = report.items.find((i) => i.dimension === "firmas")!;
    expect(item.status).toBe("rojo");
    expect(item.detail).toMatch(/nunca firma ni simula firma/);
  });

  it("una firma confirmada por el usuario (fuera del sistema) pasa verde", () => {
    const report = new IntegrityChecklist().run(baseInput({ requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }] }));
    expect(report.items.find((i) => i.dimension === "firmas")!.status).toBe("verde");
  });
});

describe("checkAnexosObligatorios (REQ-LIC-003)", () => {
  it("falta un anexo obligatorio -> rojo, con el id del faltante como evidencia", () => {
    const report = new IntegrityChecklist().run(baseInput({ requiredAnnexes: [{ id: "req-1", text: "Anexo 3 (garantía)", topicKey: "garantia" }], presentAnnexRefs: [] }));
    const item = report.items.find((i) => i.dimension === "anexos_obligatorios")!;
    expect(item.status).toBe("rojo");
    expect(item.evidence).toEqual(["req-1"]);
  });

  it("el anexo obligatorio presente (por topicKey) pasa verde", () => {
    const report = new IntegrityChecklist().run(baseInput({ requiredAnnexes: [{ id: "req-1", text: "Anexo 3", topicKey: "garantia" }], presentAnnexRefs: ["garantia"] }));
    expect(report.items.find((i) => i.dimension === "anexos_obligatorios")!.status).toBe("verde");
  });
});

describe("checkVigencias (REQ-LIC-004) -- vigencia a la fecha del ACTO, no a 'hoy'", () => {
  const doc: CompanyDocument = { id: "d1", companyId: "org1", type: "opinion_cumplimiento", label: "Opinión de cumplimiento SAT", issuedAt: "2026-01-01T00:00:00-06:00", expiresAt: "2026-05-01T00:00:00-06:00", approvalStatus: "aprobado" };

  it("un documento vencido ANTES de la fecha del acto bloquea, aunque 'hoy' esté lejos", () => {
    const report = new IntegrityChecklist().run(baseInput({ documentsToValidate: [{ document: doc, asOfIso: "2026-06-01T00:00:00-06:00" }] }));
    expect(report.items.find((i) => i.dimension === "vigencias")!.status).toBe("rojo");
  });

  it("el mismo documento pasa verde si la fecha del acto es ANTERIOR a su vencimiento", () => {
    const report = new IntegrityChecklist().run(baseInput({ documentsToValidate: [{ document: doc, asOfIso: "2026-03-01T00:00:00-06:00" }] }));
    expect(report.items.find((i) => i.dimension === "vigencias")!.status).toBe("verde");
  });
});

describe("checkCalculosEconomicos", () => {
  it("sin propuesta económica calculada -> rojo", () => {
    const report = new IntegrityChecklist().run(baseInput({ economicResult: null }));
    expect(report.items.find((i) => i.dimension === "calculos_economicos")!.status).toBe("rojo");
  });

  it("con conceptos bloqueados -> rojo, incluso si totals es null", () => {
    const report = new IntegrityChecklist().run(baseInput({ economicResult: { lineItems: [], blockedLineItems: [{ concept: "x", status: "missing", detail: "sin tarifa" }], totals: null, cartaText: null, anexoText: null } }));
    expect(report.items.find((i) => i.dimension === "calculos_economicos")!.status).toBe("rojo");
  });
});

describe("checkConsistenciaCruzada -- nunca 'resolver' el ámbar duplicando artificialmente", () => {
  it("menos de 2 documentos comparables -> ambar (nunca verde)", () => {
    const report = new IntegrityChecklist().run(baseInput({ crossDocumentTotals: [{ documentLabel: "carta", total: "116.00" }] }));
    expect(report.items.find((i) => i.dimension === "consistencia_cruzada")!.status).toBe("ambar");
  });

  it("ambar sigue bloqueando el overallStatus 'verde' (ambar != verde)", () => {
    const report = new IntegrityChecklist().run(baseInput({ crossDocumentTotals: [{ documentLabel: "carta", total: "116.00" }] }));
    expect(report.overallStatus).not.toBe("verde");
  });

  it("totales inconsistentes entre documentos -> rojo", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        crossDocumentTotals: [
          { documentLabel: "carta", total: "116.00" },
          { documentLabel: "anexo", total: "999.00" },
        ],
      }),
    );
    expect(report.items.find((i) => i.dimension === "consistencia_cruzada")!.status).toBe("rojo");
  });
});
