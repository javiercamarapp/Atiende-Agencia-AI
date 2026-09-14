import { describe, expect, it, vi } from "vitest";
import { fetchChecklist } from "../src/verticals/licitaciones/lib/checklist-client.ts";

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
