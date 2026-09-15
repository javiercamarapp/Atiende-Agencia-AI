import { describe, expect, it, vi } from "vitest";
import {
  addContractDocument,
  confirmContractExtractedField,
  createContract,
  fetchContract,
  fetchContractDocumentFields,
  fetchContractDocuments,
  fetchContractHistory,
  transitionContract,
  updateContractMetadata,
} from "../src/verticals/licitaciones/lib/contract-client.ts";

const CONTRACT = {
  id: "contract-1",
  organizationId: "org-1",
  tenderId: "t1",
  status: "adjudicado" as const,
  endDate: null,
  contractNumber: null,
  hasRenewalOption: false,
  renewalOptionNotes: null,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("createContract", () => {
  it("hace POST .../contract y devuelve el ContractRecord tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(CONTRACT), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(CONTRACT);
  });

  it("409 (ya existe un contrato) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Ya existe un contrato registrado para esta convocatoria." }), { status: 409 })) as unknown as typeof fetch;
    await expect(createContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("Ya existe un contrato registrado");
  });
});

describe("fetchContract", () => {
  it("hace GET .../contract y devuelve el ContractRecord", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract");
      return new Response(JSON.stringify(CONTRACT), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(CONTRACT);
  });

  it("404 (sin contrato registrado todavía) -> null, NUNCA lanza (mismo criterio que fetchLatestPackage)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No existe contrato registrado..." }), { status: 404 })) as unknown as typeof fetch;
    const result = await fetchContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toBeNull();
  });

  it("500 (error real del servidor) -> sigue lanzando", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Error interno." }), { status: 500 })) as unknown as typeof fetch;
    await expect(fetchContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("Error interno.");
  });
});

describe("updateContractMetadata", () => {
  it("hace PATCH .../contract con solo los campos presentes en el input", async () => {
    const updated = { ...CONTRACT, contractNumber: "C-123" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ contractNumber: "C-123" });
      return new Response(JSON.stringify(updated), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateContractMetadata(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { contractNumber: "C-123" });
    expect(result).toEqual(updated);
  });

  it("400 (endDate mal formado) -> propaga el mensaje de validación real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'endDate: se esperaba "YYYY-MM-DD" o null.' }), { status: 400 })) as unknown as typeof fetch;
    await expect(updateContractMetadata(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { endDate: "not-a-date" })).rejects.toThrow("endDate: se esperaba");
  });
});

describe("fetchContractHistory", () => {
  it("hace GET .../contract/history y devuelve el arreglo", async () => {
    const item = { id: "h1", contractId: "contract-1", fromStatus: null, toStatus: "adjudicado" as const, reason: "Alta del contrato.", actorId: "user-1", evidenceRef: null, createdAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/history");
      return new Response(JSON.stringify({ history: [item] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchContractHistory(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([item]);
  });
});

describe("transitionContract", () => {
  it("hace POST .../contract/transition con {toStatus, reason, evidenceRef}", async () => {
    const updated = { ...CONTRACT, status: "contrato_firmado_declarado" as const };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/transition");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ toStatus: "contrato_firmado_declarado", reason: "Firmado por ambas partes.", evidenceRef: "oficio-99" });
      return new Response(JSON.stringify(updated), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await transitionContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { toStatus: "contrato_firmado_declarado", reason: "Firmado por ambas partes.", evidenceRef: "oficio-99" });
    expect(result).toEqual(updated);
  });

  it("evidenceRef ausente -> manda null explícito (nunca omite el campo)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ toStatus: "rescindido", reason: "Incumplimiento grave.", evidenceRef: null });
      return new Response(JSON.stringify({ ...CONTRACT, status: "rescindido" }), { status: 200 });
    }) as unknown as typeof fetch;
    await transitionContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { toStatus: "rescindido", reason: "Incumplimiento grave." });
  });

  it("409 (transición inválida) -> propaga el mensaje real del servidor con los estados permitidos", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: '"adjudicado" -> "cerrado" no es una transición válida.' }), { status: 409 })) as unknown as typeof fetch;
    await expect(transitionContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { toStatus: "cerrado", reason: "x" })).rejects.toThrow("no es una transición válida");
  });

  it("403 (rol sin DECISION_ROLES para rescindir) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para esta transición." }), { status: 403 })) as unknown as typeof fetch;
    await expect(transitionContract(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { toStatus: "rescindido", reason: "x" })).rejects.toThrow("No tienes permiso");
  });
});

describe("addContractDocument", () => {
  it("hace POST .../contract/documents con {documentLabel, contentBase64, mimeType, filename}", async () => {
    const doc = { id: "doc-1", contractId: "contract-1", documentLabel: "Contrato firmado", pageCount: 3, uploadedBy: "user-1", createdAt: "2026-01-01T00:00:00Z" };
    const field = { id: "f1", contractDocumentId: "doc-1", fieldKey: "monto_total" as const, extractedValue: "$100,000.00", sourcePage: 2, sourceClause: "Cláusula TERCERA", confidence: 0.8, status: "sugerido" as const, confirmedValue: null, confirmedBy: null, confirmedAt: null, createdAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/documents");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ documentLabel: "Contrato firmado", contentBase64: "QUJD", mimeType: "application/pdf", filename: "contrato.pdf" });
      return new Response(JSON.stringify({ document: doc, fields: [field] }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await addContractDocument(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { documentLabel: "Contrato firmado", contentBase64: "QUJD", mimeType: "application/pdf", filename: "contrato.pdf" });
    expect(result).toEqual({ document: doc, fields: [field] });
  });

  it("422 (documento sin texto extraíble) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Ningún documento produjo texto extraíble: "contrato firmado" (requires_ocr).' }), { status: 422 })) as unknown as typeof fetch;
    await expect(
      addContractDocument(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { documentLabel: "contrato firmado", contentBase64: "AAAA", mimeType: null, filename: "x.pdf" }),
    ).rejects.toThrow("texto extraíble");
  });
});

describe("fetchContractDocuments / fetchContractDocumentFields", () => {
  it("hace GET .../contract/documents y devuelve el arreglo", async () => {
    const doc = { id: "doc-1", contractId: "contract-1", documentLabel: "Contrato firmado", pageCount: 3, uploadedBy: "user-1", createdAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/documents");
      return new Response(JSON.stringify({ documents: [doc] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchContractDocuments(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([doc]);
  });

  it("hace GET .../contract/documents/:documentId/fields y devuelve el arreglo", async () => {
    const field = { id: "f1", contractDocumentId: "doc-1", fieldKey: "numero_contrato" as const, extractedValue: "C-99", sourcePage: 1, sourceClause: null, confidence: 0.75, status: "sugerido" as const, confirmedValue: null, confirmedBy: null, confirmedAt: null, createdAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/documents/doc-1/fields");
      return new Response(JSON.stringify({ fields: [field] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchContractDocumentFields(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "doc-1");
    expect(result).toEqual([field]);
  });
});

describe("confirmContractExtractedField", () => {
  it('action "confirm" -> POST .../fields/:fieldId/confirm con correctedValue: null', async () => {
    const confirmed = { id: "f1", contractDocumentId: "doc-1", fieldKey: "numero_contrato" as const, extractedValue: "C-99", sourcePage: 1, sourceClause: null, confidence: 0.75, status: "confirmado" as const, confirmedValue: "C-99", confirmedBy: "user-1", confirmedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/contract/fields/f1/confirm");
      expect(JSON.parse(init!.body as string)).toEqual({ action: "confirm", correctedValue: null });
      return new Response(JSON.stringify(confirmed), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await confirmContractExtractedField(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "f1", { action: "confirm" });
    expect(result).toEqual(confirmed);
  });

  it('action "correct" -> manda correctedValue tal cual', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ action: "correct", correctedValue: "C-100" });
      return new Response(JSON.stringify({ id: "f1", contractDocumentId: "doc-1", fieldKey: "numero_contrato", extractedValue: "C-99", sourcePage: 1, sourceClause: null, confidence: 0.75, status: "corregido", confirmedValue: "C-100", confirmedBy: "user-1", confirmedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    await confirmContractExtractedField(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "f1", { action: "correct", correctedValue: "C-100" });
  });

  it("404 (campo no encontrado) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Campo extraído no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(confirmContractExtractedField(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "f-missing", { action: "confirm" })).rejects.toThrow("Campo extraído no encontrado.");
  });
});
