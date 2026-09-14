import { describe, expect, it, vi } from "vitest";
import { createOrUpdateTender, fetchTender, fetchTenders } from "../src/verticals/licitaciones/lib/tenders-client.ts";

const TENDER = {
  id: "t1",
  organizationId: "org1",
  title: "Adquisición de equipo de cómputo",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  updatedAt: "2026-01-01T00:00:00Z",
  source: "manual",
  externalId: "LA-01/2026",
  contractingBody: "Secretaría de X",
  cpvCodes: [],
  budgetAmount: 250000,
  currency: "MXN",
  state: null,
  procedureTypeRaw: null,
  status: "discovered",
};

describe("fetchTenders", () => {
  it("pide GET .../tenders y devuelve la lista tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders");
      return new Response(JSON.stringify({ tenders: [TENDER] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchTenders(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([TENDER]);
  });
});

describe("fetchTender", () => {
  it("pide GET .../tenders/:tenderId y devuelve el TenderRecord", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1");
      return new Response(JSON.stringify(TENDER), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchTender(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual(TENDER);
  });

  it("404 -> error con el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Convocatoria no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchTender(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Convocatoria no encontrada.");
  });
});

describe("createOrUpdateTender", () => {
  it("hace POST .../tenders con el body dado y devuelve el tender creado/actualizado", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ title: "Nueva convocatoria" });
      return new Response(JSON.stringify(TENDER), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createOrUpdateTender(fetchImpl, "http://api.local", "tok", "prop-1", { title: "Nueva convocatoria" });
    expect(result).toEqual(TENDER);
  });

  it("403 (viewer) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No autorizado." }), { status: 403 })) as unknown as typeof fetch;
    await expect(createOrUpdateTender(fetchImpl, "http://api.local", "tok", "prop-1", { title: "X" })).rejects.toThrow("No autorizado.");
  });
});
