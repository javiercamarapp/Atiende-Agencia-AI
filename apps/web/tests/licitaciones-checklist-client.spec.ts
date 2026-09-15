import { describe, expect, it, vi } from "vitest";
import { fetchChecklist, runChecklist } from "../src/verticals/licitaciones/lib/checklist-client.ts";

describe("fetchChecklist", () => {
  it("pide GET .../checklist y devuelve overallStatus + items tal cual", async () => {
    const body = { overallStatus: "ambar", items: [{ id: "c1", dimension: "formatos", result: "ambar", notes: "1 archivo excede el tamaño máximo", evidenceRef: null, checkedAt: "2026-01-01T00:00:00Z" }] };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/checklist");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(body);
  });

  it("sin propuesta/checklist corrido todavía -> overallStatus 'verde' con items vacíos (nunca 404)", async () => {
    const body = { overallStatus: "verde", items: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result.items).toEqual([]);
  });
});

describe("runChecklist", () => {
  const input = {
    files: [{ filename: "acta.pdf", extension: "pdf", sizeBytes: 12_345, pages: 3 }],
    formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 20 },
    requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }],
    presentAnnexRefs: ["anexo_1"],
  };

  it("hace POST .../checklist/run con idempotency-key y el body tal cual (nunca manda asOfIso)", async () => {
    const body = { overallStatus: "verde", items: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/checklist/run");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBeTruthy();
      const parsed = JSON.parse(init!.body as string);
      expect(parsed).toEqual(input);
      expect(parsed.asOfIso).toBeUndefined();
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1", input);
    expect(result).toEqual(body);
  });

  it("respeta un idempotency-key explícito en vez de generar uno nuevo", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["idempotency-key"]).toBe("fixed-checklist-key");
      return new Response(JSON.stringify({ overallStatus: "verde", items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await runChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1", input, "fixed-checklist-key");
  });

  it("404 (sin propuesta generada todavía) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Genere primero la propuesta (GET /proposal) antes de ejecutar el checklist." }), { status: 404 })) as unknown as typeof fetch;
    await expect(runChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1", input)).rejects.toThrow("Genere primero la propuesta");
  });

  it("403 (rol sin WRITE_ROLES) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(runChecklist(fetchImpl, "http://api.local", "tok", "prop-1", "t1", input)).rejects.toThrow("No tienes permiso");
  });
});
