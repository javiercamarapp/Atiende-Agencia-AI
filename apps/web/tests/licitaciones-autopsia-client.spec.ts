import { describe, expect, it, vi } from "vitest";
import { createFalloAutopsy, fetchFalloAutopsies, fetchLessonsLearned } from "../src/verticals/licitaciones/lib/autopsia-client.ts";

const AUTOPSY = {
  id: "a1",
  organizationId: "org1",
  tenderId: "t1",
  ownProposalStatus: "desechada",
  disqualificationReason: "no disponible",
  ownScore: 70,
  winnerScore: 85,
  ownPrice: 100000,
  winnerPrice: 95000,
  winnerName: "no disponible",
  criteriaComparison: [{ criterio: "Experiencia", propio: "5 años", ganador: "8 años" }],
  createdBy: "user1",
  createdAt: "2026-01-02T00:00:00Z",
};

const LESSON = {
  id: "l1",
  organizationId: "org1",
  falloAutopsyId: "a1",
  tenderId: "t1",
  lessonText: "Pedir la constancia de cumplimiento con más anticipación",
  createdAt: "2026-01-02T00:00:00Z",
};

describe("createFalloAutopsy", () => {
  it("hace POST .../fallo-autopsy con los campos ausentes como null, nunca undefined ni 0 inventado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/fallo-autopsy");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        ownProposalStatus: "desechada",
        disqualificationReason: null,
        ownScore: null,
        winnerScore: null,
        ownPrice: null,
        winnerPrice: null,
        winnerName: null,
        criteriaComparison: [],
        lessons: [],
      });
      return new Response(JSON.stringify({ ...AUTOPSY, lessons: [LESSON] }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createFalloAutopsy(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { ownProposalStatus: "desechada" });
    expect(result.id).toBe("a1");
    expect(result.lessons).toEqual([LESSON]);
  });

  it("403 (rol sin permiso de escritura) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No puedes registrar autopsias." }), { status: 403 })) as unknown as typeof fetch;
    await expect(createFalloAutopsy(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { ownProposalStatus: "ganadora" })).rejects.toThrow("No puedes registrar autopsias.");
  });
});

describe("fetchFalloAutopsies", () => {
  it("pide GET .../fallo-autopsy y devuelve todas las registradas", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/fallo-autopsy");
      return new Response(JSON.stringify({ autopsies: [AUTOPSY] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchFalloAutopsies(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([AUTOPSY]);
  });
});

describe("fetchLessonsLearned", () => {
  it("pide GET .../lessons-learned (org-wide, sin tenderId en la ruta)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/lessons-learned");
      return new Response(JSON.stringify({ lessons: [LESSON] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchLessonsLearned(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([LESSON]);
  });
});
