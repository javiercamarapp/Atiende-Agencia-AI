import { describe, expect, it, vi } from "vitest";
import { fetchMatchingDetail, fetchMatchingList } from "../src/verticals/licitaciones/lib/matching-client.ts";

const MATCH_RESULT = {
  tenderId: "t1",
  score: 72,
  criteria: [{ criterion: "keywords", score: 30, maxScore: 40, explanation: "3 de 4 palabras clave presentes" }],
  eligibility: { status: "cumple", criteria: [{ requirement: "budget", status: "cumple", explanation: "Dentro del presupuesto configurado" }] },
};

describe("fetchMatchingList", () => {
  it("pide GET .../tenders/matching y devuelve los results", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/matching");
      return new Response(JSON.stringify({ results: [MATCH_RESULT] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMatchingList(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([MATCH_RESULT]);
  });
});

describe("fetchMatchingList acotado (paridad3)", () => {
  it("manda ids/limit/offset para puntuar solo la pagina visible", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe("/licitaciones/prop-1/tenders/matching");
      expect(Object.fromEntries(u.searchParams)).toEqual({ ids: "t1,t2", limit: "2", offset: "0" });
      return new Response(JSON.stringify({ results: [MATCH_RESULT] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMatchingList(fetchImpl, "http://api.local", "tok", "prop-1", { ids: ["t1", "t2"], limit: 2, offset: 0 });
  });
});

describe("fetchMatchingDetail", () => {
  it("pide GET .../tenders/:tenderId/matching y devuelve el MatchResult", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/matching");
      return new Response(JSON.stringify(MATCH_RESULT), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMatchingDetail(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(MATCH_RESULT);
  });
});
