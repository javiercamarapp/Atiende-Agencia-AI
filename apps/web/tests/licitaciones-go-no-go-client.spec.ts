import { describe, expect, it, vi } from "vitest";
import { createGoNoGoDecision, fetchGoNoGoDecisions } from "../src/verticals/licitaciones/lib/go-no-go-client.ts";

const DECISION = {
  id: "d1",
  organizationId: "org1",
  tenderId: "t1",
  decision: "go",
  reasons: ["Encaja con nuestro giro"],
  matchScore: 72,
  matchEligibilityStatus: "cumple",
  matchInputsHash: "abc",
  decidedBy: "user1",
  decidedAt: "2026-01-02T00:00:00Z",
};

describe("fetchGoNoGoDecisions", () => {
  it("pide GET .../go-no-go y devuelve el historial completo", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/go-no-go");
      return new Response(JSON.stringify({ decisions: [DECISION] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchGoNoGoDecisions(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([DECISION]);
  });
});

describe("createGoNoGoDecision", () => {
  it("hace POST .../go-no-go con decision+reasons, nunca con un score", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/go-no-go");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ decision: "go", reasons: ["Encaja con nuestro giro"] });
      expect(body.score).toBeUndefined();
      return new Response(JSON.stringify(DECISION), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createGoNoGoDecision(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { decision: "go", reasons: ["Encaja con nuestro giro"] });
    expect(result).toEqual(DECISION);
  });

  it("403 (rol sin permiso de decisión) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No puedes tomar esta decisión." }), { status: 403 })) as unknown as typeof fetch;
    await expect(createGoNoGoDecision(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { decision: "no_go", reasons: ["x"] })).rejects.toThrow("No puedes tomar esta decisión.");
  });
});
