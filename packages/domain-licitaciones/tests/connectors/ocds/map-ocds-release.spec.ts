// Fase 9 — parser OCDS puro y genérico, probado contra un fixture REAL
// (recortado, ver ../fixtures/ocds/nl-releases-page-sample.json) capturado con
// una petición GET real contra la API OCDS de Nuevo León el 2026-09-19 (ver
// evidencia completa en connector-registry.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDroppedResult, isVigenteTender, mapOcdsReleaseToCandidate } from "../../../src/connectors/ocds/map-ocds-release.ts";
import type { OcdsRelease } from "../../../src/connectors/ocds/types.ts";

const FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/ocds/nl-releases-page-sample.json", import.meta.url));

function loadFixtureReleases(): OcdsRelease[] {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { data: { releases: OcdsRelease[] }[] };
  return parsed.data.flatMap((group) => group.releases);
}

describe("mapOcdsReleaseToCandidate (fixture REAL de Nuevo León)", () => {
  const releases = loadFixtureReleases();

  it("mapea un release real 'active' con items/classification/additionalClassifications a un candidato completo", () => {
    const release = releases.find((r) => r.ocid === "ocds-k3ufh7-338790" && r.date === "2026-08-18T10:09:03Z")!;
    const result = mapOcdsReleaseToCandidate(release, { fixedState: "Nuevo León" });
    expect(isDroppedResult(result)).toBe(false);
    if (isDroppedResult(result)) throw new Error("unreachable");
    expect(result.candidate.externalId).toBe("ocds-k3ufh7-338790");
    expect(result.candidate.title).toBe("REFACCIONES Y ACCESORIOS MENORES DE EQUIPO DE TRANSPORTE");
    expect(result.candidate.contractingBody).toBe("SERVICIOS DE PROTECCIÓN INSTITUCIONAL"); // buyer.name gana sobre procuringEntity.name
    expect(result.candidate.budgetAmount).toBe(234552);
    expect(result.candidate.currency).toBe("MXN");
    expect(result.candidate.state).toBe("Nuevo León");
    // El código real vive en additionalClassifications[].id (ver decisión CPV/CUCOP) -- classification.description no trae id/scheme en esta fuente real.
    expect(result.candidate.cpvCodes.length).toBeGreaterThan(0);
    expect(result.candidate.cpvCodes.every((c) => /^\d+$/.test(c))).toBe(true);
  });

  it("tenderPeriod.endDate real con offset explícito (-06:00) se conserva tal cual", () => {
    const release = releases.find((r) => r.ocid === "ocds-k3ufh7-317364")!;
    const result = mapOcdsReleaseToCandidate(release, { fixedState: "Nuevo León" });
    if (isDroppedResult(result)) throw new Error("no debería descartarse");
    expect(result.candidate.submissionDeadline).toBe("2025-02-04T18:48:17-06:00");
  });

  it("release sin ocid se descarta con motivo -- nunca se fabrica una clave", () => {
    const result = mapOcdsReleaseToCandidate({ tender: { title: "X" } }, { fixedState: null });
    expect(isDroppedResult(result)).toBe(true);
    if (!isDroppedResult(result)) throw new Error("unreachable");
    expect(result.droppedReason).toMatch(/ocid/);
  });

  it("release sin tender.title se descarta con motivo", () => {
    const result = mapOcdsReleaseToCandidate({ ocid: "ocds-x-1", tender: {} }, { fixedState: null });
    expect(isDroppedResult(result)).toBe(true);
    if (!isDroppedResult(result)) throw new Error("unreachable");
    expect(result.droppedReason).toMatch(/title/);
  });

  it("tenderPeriod.endDate SIN offset explícito se descarta -- nunca se asume una zona no declarada", () => {
    const result = mapOcdsReleaseToCandidate({ ocid: "ocds-x-2", tender: { title: "X", tenderPeriod: { endDate: "2026-12-01T18:00:00" } } }, { fixedState: null });
    expect(isDroppedResult(result)).toBe(true);
    if (!isDroppedResult(result)) throw new Error("unreachable");
    expect(result.droppedReason).toMatch(/offset/);
  });

  it("sin buyer/procuringEntity, contractingBody es null -- nunca se inventa", () => {
    const result = mapOcdsReleaseToCandidate({ ocid: "ocds-x-3", tender: { title: "X" } }, { fixedState: null });
    if (isDroppedResult(result)) throw new Error("no debería descartarse");
    expect(result.candidate.contractingBody).toBeNull();
    expect(result.candidate.budgetAmount).toBeNull();
    expect(result.candidate.cpvCodes).toEqual([]);
  });

  it("prefiere record.compiledRelease sobre el resto del record (soporte de record package)", () => {
    const record = {
      ocid: "ocds-record-1",
      compiledRelease: { ocid: "ocds-record-1", tender: { title: "Título compilado", status: "active" } },
      releases: [{ ocid: "ocds-record-1", tender: { title: "Título viejo, ignorado" } }],
    };
    const result = mapOcdsReleaseToCandidate(record, { fixedState: null });
    if (isDroppedResult(result)) throw new Error("no debería descartarse");
    expect(result.candidate.title).toBe("Título compilado");
  });

  it("deduplica classification.id y additionalClassifications[].id repetidos entre items", () => {
    const release: OcdsRelease = {
      ocid: "ocds-x-4",
      tender: {
        title: "X",
        items: [
          { classification: { id: "43211500" } },
          { classification: { id: "43211500" } }, // repetido
          { additionalClassifications: [{ id: 22102 }] },
        ],
      },
    };
    const result = mapOcdsReleaseToCandidate(release, { fixedState: null });
    if (isDroppedResult(result)) throw new Error("no debería descartarse");
    expect([...result.candidate.cpvCodes].sort()).toEqual(["22102", "43211500"]);
  });
});

describe("isVigenteTender", () => {
  const now = new Date("2026-09-19T00:00:00Z");

  it("status 'active' es vigente incluso SIN tenderPeriod -- evidencia real: 615/615 releases activos reales verificados no traían tenderPeriod", () => {
    expect(isVigenteTender({ status: "active" }, now)).toBe(true);
  });

  it("tenderPeriod.endDate futuro es vigente aunque el status no sea 'active'", () => {
    expect(isVigenteTender({ status: "complete", tenderPeriod: { endDate: "2026-12-01T00:00:00-06:00" } }, now)).toBe(true);
  });

  it("tenderPeriod.endDate pasado y status distinto de 'active' NO es vigente", () => {
    expect(isVigenteTender({ status: "complete", tenderPeriod: { endDate: "2020-01-01T00:00:00-06:00" } }, now)).toBe(false);
  });

  it("sin tender, nunca vigente", () => {
    expect(isVigenteTender(null, now)).toBe(false);
    expect(isVigenteTender(undefined, now)).toBe(false);
  });

  it("tenderPeriod.endDate no parseable se trata como ausente (nunca lanza)", () => {
    expect(isVigenteTender({ status: "complete", tenderPeriod: { endDate: "no-es-fecha" } }, now)).toBe(false);
  });
});
