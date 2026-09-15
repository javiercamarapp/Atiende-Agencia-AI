import { describe, expect, it, vi } from "vitest";
import { extractRequirements, fetchRequirementItems } from "../src/verticals/licitaciones/lib/requirements-client.ts";
import type { ExtractDocumentInput } from "../src/verticals/licitaciones/lib/requirements-client.ts";

const RECORD = {
  id: "r1",
  documentId: "d1",
  text: "Presentar acta constitutiva vigente.",
  requirementKind: "legal",
  obligatoriedad: "obligatorio",
  topicKey: "acta_constitutiva",
  requiredEvidence: ["acta_constitutiva"],
  extractedBy: "rule",
  page: 3,
  clause: "2.1",
  responsibleRole: "legal",
  deadline: null,
  status: "pendiente",
  confidence: null,
};

describe("fetchRequirementItems", () => {
  it("pide GET .../requirements y devuelve items tal cual (forma RequirementItemRecord persistida)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/requirements");
      return new Response(JSON.stringify({ items: [RECORD] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRequirementItems(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([RECORD]);
  });

  it("sin extracción corrida todavía -> items vacío (nunca 404)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchRequirementItems(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([]);
  });
});

describe("extractRequirements", () => {
  const documents: readonly ExtractDocumentInput[] = [
    { documentId: "doc-1", documentLabel: "Bases.pdf", publishedAt: "2026-01-01T00:00:00.000Z", contentBase64: "JVBERi0xLjQK", mimeType: "application/pdf", filename: "Bases.pdf" },
  ];

  it("hace POST .../requirements/extract con idempotency-key y el body { documents }, y devuelve items/conflicts/skippedDocuments", async () => {
    const body = { items: [], conflicts: [], skippedDocuments: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/requirements/extract");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBeTruthy();
      expect(JSON.parse(init!.body as string)).toEqual({ documents });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await extractRequirements(fetchImpl, "http://api.local", "tok", "prop-1", "t1", documents);
    expect(result).toEqual(body);
  });

  it("respeta un idempotency-key explícito en vez de generar uno nuevo", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBe("fixed-key-123");
      return new Response(JSON.stringify({ items: [], conflicts: [], skippedDocuments: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await extractRequirements(fetchImpl, "http://api.local", "tok", "prop-1", "t1", documents, "fixed-key-123");
  });

  it("422 (ningún documento extraíble) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Ningún documento produjo texto extraíble: "Bases.pdf" (requires_ocr).' }), { status: 422 }),
    ) as unknown as typeof fetch;
    await expect(extractRequirements(fetchImpl, "http://api.local", "tok", "prop-1", "t1", documents)).rejects.toThrow("Ningún documento produjo texto extraíble");
  });
});
