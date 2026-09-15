import { describe, expect, it, vi } from "vitest";
import { fetchOrCreateProposal, generateTechnicalProposal, upsertRequirementMapping } from "../src/verticals/licitaciones/lib/technical-proposal-client.ts";

const PROPOSAL = {
  id: "prop-1",
  tenderId: "t1",
  title: "Propuesta — Convocatoria de prueba",
  generationReport: { technical: { usedCompanyDocumentIds: ["doc-acta-1"], notApplicableRequirements: [] } },
  correlationId: null,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("fetchOrCreateProposal", () => {
  it("pide GET .../proposal y devuelve el ProposalRecord tal cual (lazy-create del servidor)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/proposal");
      return new Response(JSON.stringify(PROPOSAL), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchOrCreateProposal(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(PROPOSAL);
  });
});

describe("generateTechnicalProposal", () => {
  it("hace POST .../proposal/technical/generate con idempotency-key y { conditionEvaluations }", async () => {
    const body = { sections: [{ sectionKey: "technical:legal", label: "Cumplimiento legal" }], blockers: 0, notApplicableRequirements: [], correlationId: "req-1" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/proposal/technical/generate");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBeTruthy();
      expect(JSON.parse(init!.body as string)).toEqual({ conditionEvaluations: { "req-cond-1": true } });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await generateTechnicalProposal(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { "req-cond-1": true });
    expect(result).toEqual(body);
  });

  it("sin conditionEvaluations explícito, manda {} (nunca omite el campo)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ conditionEvaluations: {} });
      return new Response(JSON.stringify({ sections: [], blockers: 0, notApplicableRequirements: [], correlationId: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await generateTechnicalProposal(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
  });

  it("respeta un idempotency-key explícito en vez de generar uno nuevo", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBe("fixed-key-123");
      return new Response(JSON.stringify({ sections: [], blockers: 0, notApplicableRequirements: [], correlationId: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await generateTechnicalProposal(fetchImpl, "http://api.local", "tok", "prop-1", "t1", {}, "fixed-key-123");
  });

  it("404 (sin propuesta creada todavía) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Genere primero la propuesta antes de redactar la propuesta técnica." }), { status: 404 })) as unknown as typeof fetch;
    await expect(generateTechnicalProposal(fetchImpl, "http://api.local", "tok", "prop-1", "t1")).rejects.toThrow("Genere primero la propuesta");
  });
});

describe("upsertRequirementMapping", () => {
  const input = { kind: "document" as const, refKey: "acta_constitutiva", statementTemplate: "Se acompaña acta constitutiva vigente: {value}." };

  it("hace PUT .../requirement-mappings/:topicKey con el body tal cual y codifica el topicKey en la URL", async () => {
    const record = { id: "map-1", topicKey: "acta constitutiva/es", kind: "document" as const, refKey: "acta_constitutiva", statementTemplate: input.statementTemplate };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/requirement-mappings/acta%20constitutiva%2Fes");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual(input);
      return new Response(JSON.stringify(record), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await upsertRequirementMapping(fetchImpl, "http://api.local", "tok", "prop-1", "acta constitutiva/es", input);
    expect(result).toEqual(record);
  });

  it("403 (rol sin DECISION_ROLES) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para configurar el mapeo de cumplimiento." }), { status: 403 })) as unknown as typeof fetch;
    await expect(upsertRequirementMapping(fetchImpl, "http://api.local", "tok", "prop-1", "acta_constitutiva", input)).rejects.toThrow("No tienes permiso para configurar el mapeo de cumplimiento.");
  });

  it("400 (kind inválido) -> propaga el mensaje de validación real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'kind: se esperaba "capability" | "experience" | "document" | "signer".' }), { status: 400 })) as unknown as typeof fetch;
    await expect(upsertRequirementMapping(fetchImpl, "http://api.local", "tok", "prop-1", "acta_constitutiva", input)).rejects.toThrow("kind: se esperaba");
  });
});
