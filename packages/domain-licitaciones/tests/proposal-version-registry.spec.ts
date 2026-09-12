// Fase 2 pieza 2 -- ProposalVersionRegistry. En el origen, `inputChanged`/la
// comparación insumo-por-insumo era "código muerto, 0 referencias" hasta
// conectarse a un flujo real; aquí es lo que produce el motivo LEGIBLE que
// `syncExpedienteApprovalWithCurrentHash` usa para invalidar una aprobación
// (ver postgres-repository.ts / in-memory-repository.ts).
import { describe, expect, it } from "vitest";
import { ProposalVersionRegistry } from "../src/proposal-version-registry.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";

const BASE: ExpedienteInputs = {
  tenderVersionHash: "tv1",
  companyProfileHash: "cp1",
  companyDocuments: [{ documentId: "doc-1", hash: "hd1", vigenteHasta: "2026-12-31T23:59:59-06:00" }],
  rates: [{ concept: "consultoria_hora", hash: "hr1" }],
  templates: [],
};

describe("ProposalVersionRegistry.createVersion", () => {
  it("numera versiones consecutivas empezando en 1", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const v2 = registry.createVersion({ ...BASE, rates: [{ concept: "consultoria_hora", hash: "hr2" }] });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(registry.latest()!.version).toBe(2);
  });

  it("el hash de cada versión es un HashedInputs sellado, pasable directamente a ApprovalWorkflow.approve()", () => {
    const registry = new ProposalVersionRegistry();
    const version = registry.createVersion(BASE);
    // No lanza -- es un HashedInputs legítimo, no un string calculado a mano.
    expect(version.hash.hash).toBeTypeOf("string");
    expect(version.hash.inputs).toEqual(BASE);
  });
});

describe("ProposalVersionRegistry.changedInputsSince / .diff", () => {
  it("detecta una tarifa que cambió de valor", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const changed = registry.changedInputsSince(v1, { ...BASE, rates: [{ concept: "consultoria_hora", hash: "hr-DISTINTO" }] });
    expect(changed).toEqual(["rate:consultoria_hora"]);
  });

  it("detecta un insumo REMOVIDO (existía en la versión N, ya no está) -- caso que el origen marcaba como código muerto hasta conectarlo aquí", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const changed = registry.changedInputsSince(v1, { ...BASE, rates: [] });
    expect(changed).toEqual(["rate:consultoria_hora"]);
  });

  it("detecta un insumo NUEVO que no existía en la versión registrada", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const changed = registry.changedInputsSince(v1, { ...BASE, rates: [...BASE.rates, { concept: "otro_concepto", hash: "hr-nuevo" }] });
    expect(changed).toEqual(["rate:otro_concepto"]);
  });

  it("hash combinado idéntico -> changedInputsSince vacío (no hay ruido)", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    expect(registry.changedInputsSince(v1, { ...BASE })).toEqual([]);
  });

  it("detecta múltiples insumos cambiados a la vez, ordenados alfabéticamente", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const changed = registry.changedInputsSince(v1, {
      ...BASE,
      tenderVersionHash: "tv-OTRA",
      companyDocuments: [{ documentId: "doc-1", hash: "hd-OTRO", vigenteHasta: "2026-12-31T23:59:59-06:00" }],
    });
    expect(changed).toEqual(["company_document:doc-1", "tender_version"]);
  });

  it("ProposalVersionRegistry.diff funciona directamente sobre el `inputs` persistido (ProposalInputRecord[]), sin necesitar la instancia en memoria -- forma que usa PostgresLicitacionesRepository", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    const persistedInputs = v1.inputs; // lo que viviría en licitaciones.proposal_version.inputs (jsonb)
    const changed = ProposalVersionRegistry.diff(persistedInputs, { ...BASE, rates: [{ concept: "consultoria_hora", hash: "hr-DISTINTO" }] });
    expect(changed).toEqual(["rate:consultoria_hora"]);
  });
});

describe("ProposalVersionRegistry.inputChanged", () => {
  it("un insumo que no existía en la versión cuenta como cambio", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    expect(ProposalVersionRegistry.inputChanged(v1, "rate:concepto_nuevo", { hash: "x" })).toBe(true);
  });

  it("un insumo idéntico no cuenta como cambio", () => {
    const registry = new ProposalVersionRegistry();
    const v1 = registry.createVersion(BASE);
    expect(ProposalVersionRegistry.inputChanged(v1, "tender_version", BASE.tenderVersionHash)).toBe(false);
  });
});
