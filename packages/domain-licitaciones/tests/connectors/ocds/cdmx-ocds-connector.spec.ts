// Fase 9 — conector real de CDMX (CSV de datos.cdmx.gob.mx). Las pruebas de
// `discover()` usan CSV INLINE (no el fixture real, que solo tiene filas de
// 2019-2023, ver comentario de cabecera de cdmx-ocds-connector.ts) para poder
// probar determinísticamente el filtro de vigencia (pasado/futuro) con un
// `now` inyectado -- el mapeo contra la fila REAL vive en
// `map-cdmx-csv-row.spec.ts`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCdmxOcdsConnector } from "../../../src/connectors/ocds/cdmx-ocds-connector.ts";
import { CDMX_CSV_HEADER } from "../../../src/connectors/ocds/map-cdmx-csv-row.ts";
import { CaptchaDetectedError } from "../../../src/connector-registry.ts";
import type { DroppedRowInfo } from "../../../src/connectors/types.ts";

const ACCESS_DENIED_FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/compras-mx-historico-access-denied.html", import.meta.url));
const NOW = new Date("2026-09-19T00:00:00Z");

function csvRow(fields: Partial<Record<string, string>>): string {
  const header = CDMX_CSV_HEADER.split(",");
  return header.map((h) => fields[h] ?? "").join(",");
}

function csvFixture(rows: string[]): string {
  return [CDMX_CSV_HEADER, ...rows].join("\n") + "\n";
}

function fakeFetch(body: string, init: { status?: number } = {}): typeof fetch {
  return vi.fn(async () => new Response(body, { status: init.status ?? 200, headers: { "content-type": "text/csv" } })) as unknown as typeof fetch;
}

describe("createCdmxOcdsConnector().discover()", () => {
  it("solo produce filas VIGENTES: propuestas_fecha futura sí, pasada no, ausente no", async () => {
    const csv = csvFixture([
      csvRow({ no_procedimiento: "FUTURO-1", post_title: "Vigente", entidad_convocante: "X", propuestas_fecha: "2026-12-01" }),
      csvRow({ no_procedimiento: "PASADO-1", post_title: "Vencida", entidad_convocante: "X", propuestas_fecha: "2020-01-01" }),
      csvRow({ no_procedimiento: "SIN-FECHA-1", post_title: "Sin fecha", entidad_convocante: "X", propuestas_fecha: "" }),
    ]);
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch(csv) });
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW })) results.push(c);
    expect(results.map((r) => r.externalId)).toEqual(["FUTURO-1"]);
    expect(results[0]!.submissionDeadline).toBe("2026-12-01T23:59:59-06:00");
  });

  it("respeta params.limit", async () => {
    const csv = csvFixture([
      csvRow({ no_procedimiento: "F-1", post_title: "Uno", propuestas_fecha: "2026-12-01" }),
      csvRow({ no_procedimiento: "F-2", post_title: "Dos", propuestas_fecha: "2026-12-02" }),
    ]);
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch(csv) });
    const results = [];
    for await (const c of connector.discover({ limit: 1 }, { now: () => NOW })) results.push(c);
    expect(results).toHaveLength(1);
  });

  it("reporta (vía reportDropped) filas sin identificador/título sin abortar el resto", async () => {
    const csv = csvFixture([csvRow({ no_procedimiento: "F-1", post_title: "Valida", propuestas_fecha: "2026-12-01" }), csvRow({ no_procedimiento: "", post_title: "", propuestas_fecha: "2026-12-01" })]);
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch(csv) });
    const dropped: DroppedRowInfo[] = [];
    const results = [];
    for await (const c of connector.discover({}, { now: () => NOW, reportDropped: (d) => dropped.push(d) })) results.push(c);
    expect(results.map((r) => r.externalId)).toEqual(["F-1"]);
    expect(dropped).toHaveLength(1);
  });

  it("SR-14: ante el HTML de bloqueo real, lanza CaptchaDetectedError -- nunca '0 candidatos' en silencio", async () => {
    const html = readFileSync(ACCESS_DENIED_FIXTURE_PATH, "utf8");
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch(html) });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(CaptchaDetectedError);
  });

  it("una respuesta HTTP no-ok lanza", async () => {
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch("", { status: 503 }) });
    async function drain() {
      const out = [];
      for await (const c of connector.discover({}, { now: () => NOW })) out.push(c);
      return out;
    }
    await expect(drain()).rejects.toThrow(/503/);
  });

  it("fetchDetail no está implementado", async () => {
    const connector = createCdmxOcdsConnector({ fetchImpl: fakeFetch(csvFixture([])) });
    await expect(connector.fetchDetail("X-1")).rejects.toThrow(/no está implementado/);
  });
});
