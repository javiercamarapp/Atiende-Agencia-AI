// Fase 9 — mapeo puro de una fila real del CSV de convocatorias CDMX,
// probado contra filas REALES (ver ../../fixtures/ocds/cdmx-concursos-sample.csv,
// capturado con un GET real el 2026-09-19).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapCdmxCsvRow, parsePropuestasFechaToDeadline, rowRejectionReason } from "../../../src/connectors/ocds/map-cdmx-csv-row.ts";
import { parseCsv } from "../../../src/connectors/csv.ts";

const FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/ocds/cdmx-concursos-sample.csv", import.meta.url));

describe("mapCdmxCsvRow (fixture REAL de datos.cdmx.gob.mx)", () => {
  it("mapea la primera fila real a un candidato completo -- budgetAmount SIEMPRE null (sin columna de monto, ver decisión deliberada)", async () => {
    const csv = readFileSync(FIXTURE_PATH, "utf8");
    const { rows, errors } = await parseCsv(csv);
    expect(errors).toEqual([]);
    const candidate = mapCdmxCsvRow(rows[0]!.values, { fixedState: "Ciudad de México" });
    expect(candidate).not.toBeNull();
    expect(candidate!.externalId).toBe("SCGCDMX-DGAF-LPN-01-2019");
    expect(candidate!.title).toBe("SERVICIO DE LIMPIEZA Y MANEJO DE DESECHOS EN OFICINAS DE LA CONTRALORIA GENERAL");
    expect(candidate!.contractingBody).toBe("SECRETARIA DE LA CONTRALORIA GENERAL");
    expect(candidate!.budgetAmount).toBeNull();
    expect(candidate!.currency).toBe("MXN");
    expect(candidate!.state).toBe("Ciudad de México");
    expect(candidate!.submissionDeadline).toBe("2019-01-28T23:59:59-06:00");
  });

  it("clasificador_bien_servicio genérico ('NO ESPECIFICADO') -> cpvCodes vacío, nunca un código falso", () => {
    const row = { no_procedimiento: "X-1", post_title: "T", clasificador_bien_servicio: "NO ESPECIFICADO" } as Record<string, string>;
    expect(mapCdmxCsvRow(row, { fixedState: "Ciudad de México" })?.cpvCodes).toEqual([]);
  });

  it("clasificador_bien_servicio con texto real se conserva", () => {
    const row = { no_procedimiento: "X-1", post_title: "T", clasificador_bien_servicio: "MANTENIMIENTO DE VEHICULOS" } as Record<string, string>;
    expect(mapCdmxCsvRow(row, { fixedState: "Ciudad de México" })?.cpvCodes).toEqual(["MANTENIMIENTO DE VEHICULOS"]);
  });

  it("usa 'id' como respaldo de externalId y 'contratacion_descripcion' como respaldo de título", () => {
    const row = { no_procedimiento: "", id: "1203", post_title: "", contratacion_descripcion: "Descripción real" } as Record<string, string>;
    const candidate = mapCdmxCsvRow(row, { fixedState: "Ciudad de México" });
    expect(candidate?.externalId).toBe("1203");
    expect(candidate?.title).toBe("Descripción real");
  });

  it("sin identificador/título -> null (el llamador reporta vía reportDropped)", () => {
    expect(mapCdmxCsvRow({ no_procedimiento: "", id: "", post_title: "", contratacion_descripcion: "" } as Record<string, string>, { fixedState: "Ciudad de México" })).toBeNull();
    expect(rowRejectionReason({ no_procedimiento: "", id: "" } as Record<string, string>)).toMatch(/identificador/);
    expect(rowRejectionReason({ no_procedimiento: "X-1", post_title: "" } as Record<string, string>)).toMatch(/título/);
  });
});

describe("parsePropuestasFechaToDeadline", () => {
  it("ancla una fecha real (sin hora) a America/Mexico_City fin de día", () => {
    expect(parsePropuestasFechaToDeadline("2026-12-04")).toBe("2026-12-04T23:59:59-06:00");
  });

  it("'0000-00-00 00:00:00' (placeholder real observado en el CSV) -> null, nunca una fecha fabricada", () => {
    expect(parsePropuestasFechaToDeadline("0000-00-00 00:00:00")).toBeNull();
  });

  it("vacío/undefined -> null", () => {
    expect(parsePropuestasFechaToDeadline("")).toBeNull();
    expect(parsePropuestasFechaToDeadline(undefined)).toBeNull();
  });
});
