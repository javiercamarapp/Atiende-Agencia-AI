import { describe, expect, it, vi } from "vitest";
import { createOrUpdateTender, fetchOpenTenders, fetchTender, fetchTendersByIds, fetchTendersPage, fetchTendersSummary } from "../src/verticals/licitaciones/lib/tenders-client.ts";

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

describe("fetchTendersPage (paridad3 L-P3-13: ya no se corta en 50 sin aviso)", () => {
  /** API simulada con 251 convocatorias que respeta limit/offset y anuncia total/siguiente como la real. */
  function apiCon(n: number) {
    const todas = Array.from({ length: n }, (_, i) => ({ ...TENDER, id: `t${i}` }));
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), 200);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const items = todas.slice(offset, offset + limit);
      const headers: Record<string, string> = { "x-total-count": String(n) };
      if (offset + items.length < n) headers["x-next-offset"] = String(offset + items.length);
      return new Response(JSON.stringify({ tenders: items }), { status: 200, headers });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it("con 251 convocatorias devuelve el total REAL y el siguiente offset, no 'lo que llego'", async () => {
    const { fetchImpl } = apiCon(251);
    const page = await fetchTendersPage(fetchImpl, "http://api.local", "tok", "prop-1", { limit: 50, offset: 0 });
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(251);
    expect(page.nextOffset).toBe(50);
  });

  it("la ultima pagina no trae siguiente offset", async () => {
    const { fetchImpl } = apiCon(251);
    const page = await fetchTendersPage(fetchImpl, "http://api.local", "tok", "prop-1", { limit: 50, offset: 250 });
    expect(page.items).toHaveLength(1);
    expect(page.nextOffset).toBeNull();
  });

  it("manda q/status/source/open/ids como parametros del servidor (nunca filtra en memoria)", async () => {
    const { fetchImpl, urls } = apiCon(3);
    await fetchTendersPage(fetchImpl, "http://api.local", "tok", "prop-1", { limit: 25, offset: 25, q: "  papel ", status: "go", source: "nl_ocds", open: true, ids: ["a", "b"] });
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe("/licitaciones/prop-1/tenders");
    expect(Object.fromEntries(u.searchParams)).toEqual({ limit: "25", offset: "25", q: "papel", status: "go", source: "nl_ocds", open: "true", ids: "a,b" });
  });

  it("sin cabecera de total (API vieja) no finge que es todo: cae al tamano recibido y sin siguiente", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tenders: [TENDER] }), { status: 200 })) as unknown as typeof fetch;
    const page = await fetchTendersPage(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(page).toEqual({ items: [TENDER], total: 1, nextOffset: null });
  });

  it("fetchTendersByIds pide solo esos ids, sin duplicados, en bloques del techo (250 ids -> 2 peticiones)", async () => {
    const { fetchImpl, urls } = apiCon(251);
    const ids = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const items = await fetchTendersByIds(fetchImpl, "http://api.local", "tok", "prop-1", [...ids, "t0", "t1"]);
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(new URL(u).searchParams.get("limit")).toMatch(/^(200|50)$/);
    expect(items.length).toBeGreaterThan(0);
  });

  it("fetchOpenTenders pide open=true con el techo de 200", async () => {
    const { fetchImpl, urls } = apiCon(5);
    await fetchOpenTenders(fetchImpl, "http://api.local", "tok", "prop-1");
    const u = new URL(urls[0]!);
    expect(u.searchParams.get("open")).toBe("true");
    expect(u.searchParams.get("limit")).toBe("200");
  });
});

describe("fetchTendersSummary", () => {
  it("pide GET .../tenders/summary con la ventana y devuelve los conteos del servidor", async () => {
    const resumen = { total: 251, open: 200, closingSoon: 7, windowDays: 7, byStatus: { go: 100 } };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/summary?windowDays=7");
      return new Response(JSON.stringify(resumen), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchTendersSummary(fetchImpl, "http://api.local", "tok", "prop-1", 7)).toEqual(resumen);
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
