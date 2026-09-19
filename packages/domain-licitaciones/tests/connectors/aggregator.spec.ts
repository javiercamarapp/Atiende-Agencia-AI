// Fase 9 — conector "API por pegar" de un agregador comercial de
// licitaciones. Sin proveedor elegido: estas pruebas fijan un contrato JSON
// de ejemplo (paginado por cursor) contra el tipo documentado en
// `aggregator.ts::AggregatorTenderItem`, no contra ningún proveedor real.
import { describe, expect, it, vi } from "vitest";
import { createAggregatorConnector, mapAggregatorItem } from "../../src/connectors/aggregator.ts";
import { SourceNotConfiguredError } from "../../src/connector-registry.ts";
import type { DroppedRowInfo } from "../../src/connectors/types.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("mapAggregatorItem", () => {
  it("mapea un ítem completo", () => {
    const result = mapAggregatorItem({
      externalId: "AGG-1",
      title: "Licitación de ejemplo",
      submissionDeadline: "2026-12-01T18:00:00-06:00",
      contractingBody: "Dependencia X",
      classifierCodes: ["43211500"],
      budgetAmount: 500000,
      currency: "MXN",
      state: "Jalisco",
      procedureType: "Licitación pública",
    });
    expect(result.droppedReason).toBeNull();
    expect(result.candidate).toEqual({
      externalId: "AGG-1",
      title: "Licitación de ejemplo",
      submissionDeadline: "2026-12-01T18:00:00-06:00",
      contractingBody: "Dependencia X",
      cpvCodes: ["43211500"],
      budgetAmount: 500000,
      currency: "MXN",
      state: "Jalisco",
      procedureTypeRaw: "Licitación pública",
    });
  });

  it("sin externalId/title -> null con motivo, nunca fabrica un candidato", () => {
    expect(mapAggregatorItem({ title: "X" }).candidate).toBeNull();
    expect(mapAggregatorItem({ externalId: "X" }).candidate).toBeNull();
  });

  it("submissionDeadline sin offset explícito se descarta", () => {
    const result = mapAggregatorItem({ externalId: "X", title: "T", submissionDeadline: "2026-12-01T18:00:00" });
    expect(result.candidate).toBeNull();
    expect(result.droppedReason).toMatch(/offset/);
  });
});

describe("createAggregatorConnector().discover()", () => {
  it("sin apiKey/baseUrl -> SourceNotConfiguredError, nunca intenta una petición real", async () => {
    const fetchImpl = vi.fn();
    const connector = createAggregatorConnector({ fetchImpl: fetchImpl as unknown as typeof fetch });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, {})) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(SourceNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("con credenciales, pagina por cursor hasta que nextCursor es null", async () => {
    const page1 = { items: [{ externalId: "A-1", title: "Uno" }], nextCursor: "cursor-2" };
    const page2 = { items: [{ externalId: "A-2", title: "Dos" }], nextCursor: null };
    const fetchImpl = vi.fn(async (url: string) => (String(url).includes("cursor=cursor-2") ? jsonResponse(page2) : jsonResponse(page1)));

    const connector = createAggregatorConnector({ apiKey: "k", baseUrl: "https://agg.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = [];
    for await (const c of connector.discover({}, {})) results.push(c);

    expect(results.map((r) => r.externalId)).toEqual(["A-1", "A-2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, firstCallInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((firstCallInit.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("reporta (vía reportDropped) ítems inválidos sin abortar el resto de la página", async () => {
    const pageBody = { items: [{ externalId: "A-1", title: "Válido" }, { title: "Sin externalId" }], nextCursor: null };
    const fetchImpl = vi.fn(async () => jsonResponse(pageBody));
    const connector = createAggregatorConnector({ apiKey: "k", baseUrl: "https://agg.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const c of connector.discover({}, { reportDropped: (d) => dropped.push(d) })) results.push(c);
    expect(results.map((r) => r.externalId)).toEqual(["A-1"]);
    expect(dropped).toHaveLength(1);
  });

  it("respeta params.limit", async () => {
    const pageBody = { items: [{ externalId: "A-1", title: "Uno" }, { externalId: "A-2", title: "Dos" }], nextCursor: null };
    const fetchImpl = vi.fn(async () => jsonResponse(pageBody));
    const connector = createAggregatorConnector({ apiKey: "k", baseUrl: "https://agg.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const results = [];
    for await (const c of connector.discover({ limit: 1 }, {})) results.push(c);
    expect(results).toHaveLength(1);
  });

  it("una respuesta HTTP no-ok lanza (nunca '0 registros')", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const connector = createAggregatorConnector({ apiKey: "k", baseUrl: "https://agg.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, {})) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(/500/);
  });

  it("fetchDetail no está implementado", async () => {
    const connector = createAggregatorConnector({ apiKey: "k", baseUrl: "https://agg.test" });
    await expect(connector.fetchDetail("A-1")).rejects.toThrow(/no está implementado/);
  });
});
