// Fase 8 — conector real del CSV histórico de ComprasMX.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createComprasMxHistoricoConnector, mapComprasMxHistoricoRow } from "../../src/connectors/compras-mx-historico.ts";
import { CaptchaDetectedError } from "../../src/connector-registry.ts";
import type { DroppedRowInfo } from "../../src/connectors/types.ts";

const ACCESS_DENIED_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/compras-mx-historico-access-denied.html", import.meta.url));

const REAL_HEADER = "codigo_contrato,codigo_expediente,proveedor,titulo_contrato,descripcion_contrato,contract_type,work_category_id,tipo_contratacion,tipo_expediente,importe,moneda,fecha_inicio,fecha_fin,project_code,ff_fecha_inicio,ff_fecha_fin";

function csvFixture(rows: string[]): string {
  return [REAL_HEADER, ...rows].join("\n") + "\n";
}

function fakeFetch(body: string, init: { status?: number } = {}): typeof fetch {
  return vi.fn(async () => new Response(body, { status: init.status ?? 200, headers: { "content-type": "text/csv" } })) as unknown as typeof fetch;
}

describe("mapComprasMxHistoricoRow", () => {
  const options = { publishingEntity: "SABG (histórico)" };

  it("mapea una fila real a TenderSourceIngestCandidate -- submissionDeadline SIEMPRE null (dataset histórico, ver desviación deliberada)", () => {
    const row = {
      codigo_contrato: "CTR-001",
      codigo_expediente: "EXP-001",
      proveedor: "Proveedor SA",
      titulo_contrato: "Servicio de limpieza",
      descripcion_contrato: "",
      contract_type: "",
      work_category_id: "",
      tipo_contratacion: "Licitación pública",
      tipo_expediente: "",
      importe: "125000.50",
      moneda: "MXN",
      fecha_inicio: "2020-01-01",
      fecha_fin: "2020-12-31",
      project_code: "",
      ff_fecha_inicio: "",
      ff_fecha_fin: "",
    };
    const candidate = mapComprasMxHistoricoRow(row, options);
    expect(candidate).toEqual({
      externalId: "CTR-001",
      title: "Servicio de limpieza",
      submissionDeadline: null,
      contractingBody: "SABG (histórico)",
      cpvCodes: [],
      budgetAmount: 125000.5,
      currency: "MXN",
      state: null,
      procedureTypeRaw: "Licitación pública",
    });
  });

  it("usa codigo_expediente como respaldo cuando codigo_contrato viene vacío", () => {
    const row = { codigo_contrato: "", codigo_expediente: "EXP-002", titulo_contrato: "X", importe: "", moneda: "" } as Record<string, string>;
    expect(mapComprasMxHistoricoRow(row, options)?.externalId).toBe("EXP-002");
  });

  it("devuelve null (no fabrica un registro) cuando faltan identificador o título -- el llamador lo reporta vía reportDropped", () => {
    expect(mapComprasMxHistoricoRow({ codigo_contrato: "", codigo_expediente: "", titulo_contrato: "X" } as Record<string, string>, options)).toBeNull();
    expect(mapComprasMxHistoricoRow({ codigo_contrato: "C1", codigo_expediente: "", titulo_contrato: "" } as Record<string, string>, options)).toBeNull();
  });

  it("importe no numérico -> budgetAmount null, nunca NaN ni un 0 fabricado", () => {
    const row = { codigo_contrato: "C1", titulo_contrato: "X", importe: "no-es-numero" } as Record<string, string>;
    expect(mapComprasMxHistoricoRow(row, options)?.budgetAmount).toBeNull();
  });
});

describe("createComprasMxHistoricoConnector().discover()", () => {
  it("hace una petición HTTP real (vía fetchImpl inyectado) y produce candidatos válidos", async () => {
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Titulo Uno,,,,,,1000,MXN,2020-01-01,2020-06-01,,,", "CTR-2,EXP-2,Prov,Titulo Dos,,,,,,2000,MXN,2021-01-01,2021-06-01,,,"]);
    const fetchImpl = fakeFetch(csv);
    const connector = createComprasMxHistoricoConnector({ fetchImpl, csvUrl: "https://fixture.test/historico.csv" });

    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const candidate of connector.discover({}, { reportDropped: (d) => dropped.push(d) })) results.push(candidate);

    expect(fetchImpl).toHaveBeenCalledWith("https://fixture.test/historico.csv");
    expect(results.map((r) => r.externalId)).toEqual(["CTR-1", "CTR-2"]);
    expect(results.every((r) => r.submissionDeadline === null)).toBe(true);
    expect(dropped).toEqual([]);
  });

  it("respeta params.limit -- nunca produce más de los solicitados", async () => {
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Uno,,,,,,1,MXN,,,,,", "CTR-2,EXP-2,Prov,Dos,,,,,,2,MXN,,,,,", "CTR-3,EXP-3,Prov,Tres,,,,,,3,MXN,,,,,"]);
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fakeFetch(csv) });
    const results = [];
    for await (const candidate of connector.discover({ limit: 2 }, {})) results.push(candidate);
    expect(results.map((r) => r.externalId)).toEqual(["CTR-1", "CTR-2"]);
  });

  it("reporta (vía reportDropped) filas sin identificador/título sin abortar el resto del lote", async () => {
    const csv = csvFixture(["CTR-1,EXP-1,Prov,Valida,,,,,,1,MXN,,,,,", ",,Prov,,,,,,,1,MXN,,,,,", "CTR-3,EXP-3,Prov,TambienValida,,,,,,3,MXN,,,,,"]);
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fakeFetch(csv) });
    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const candidate of connector.discover({}, { reportDropped: (d) => dropped.push(d) })) results.push(candidate);
    expect(results.map((r) => r.externalId)).toEqual(["CTR-1", "CTR-3"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/identificador/);
  });

  it("SR-14: ante el HTML de bloqueo REAL capturado en vivo (2026-09-14, ver connector-registry.ts), lanza CaptchaDetectedError -- NUNCA produce '0 candidatos' en silencio", async () => {
    const realBlockedBody = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fakeFetch(realBlockedBody) });

    async function drain() {
      const out = [];
      for await (const candidate of connector.discover({}, {})) out.push(candidate);
      return out;
    }
    await expect(drain()).rejects.toThrow(CaptchaDetectedError);
  });

  it("una respuesta HTTP no-ok lanza (nunca se interpreta como '0 registros')", async () => {
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fakeFetch("", { status: 503 }) });
    async function drain() {
      const out = [];
      for await (const candidate of connector.discover({}, {})) out.push(candidate);
      return out;
    }
    await expect(drain()).rejects.toThrow(/503/);
  });

  it("fetchDetail no está implementado (dataset de volcado masivo, sin endpoint de detalle) -- lanza explícitamente, no un `undefined` silencioso", async () => {
    const connector = createComprasMxHistoricoConnector({ fetchImpl: fakeFetch(csvFixture([])) });
    await expect(connector.fetchDetail("CTR-1")).rejects.toThrow(/no está implementado/);
  });
});
