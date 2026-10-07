// REQ-142 en el matching: las restricciones de la empresa entran a la ELEGIBILIDAD (nunca al score) y un dato sin procedencia
// queda "no_evaluable" con su motivo; nunca decide.
import { describe, expect, it } from "vitest";
import { MatchingEngine, buildMatchInputsSnapshot, computeMatchInputsHash, toOrganizationMatchingProfile } from "../src/matching-engine.ts";
import type { CompanyMatchingContext } from "../src/matching-engine.ts";
import { matchingAsOfDate, loadCompanyMatchingContext } from "../src/company-matching-context.ts";
import { ProvenanceIndex } from "../src/company-profile.ts";
import type { CompanyRestrictionRecord, FieldProvenanceRecord } from "../src/company-profile.ts";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import type { TenderRecord } from "../src/types.ts";

const tender: TenderRecord = {
  id: "t1", organizationId: "org-1", title: "Servicio de mantenimiento", submissionDeadline: "2026-12-15T18:00:00-06:00", updatedAt: "2026-01-01T00:00:00Z",
  source: "manual", externalId: null, contractingBody: null, cpvCodes: [], budgetAmount: null, currency: "MXN", state: null, procedureTypeRaw: null, status: "discovered",
};
const profile = toOrganizationMatchingProfile(null, "org-1");
const engine = new MatchingEngine();
const prov = (id: string): FieldProvenanceRecord => ({ id: `p-${id}`, entity: "restriction", entityId: id, field: "*", ownerUserId: "u1", source: "manual", capturedAt: "2026-03-01T10:00:00Z" });
const restr = (over: Partial<CompanyRestrictionRecord> = {}): CompanyRestrictionRecord => ({ id: "r1", kind: "sancion", description: "texto interno", validFrom: "2026-01-01", validUntil: null, approvalStatus: "aprobado", ...over });
const ctx = (restrictions: CompanyRestrictionRecord[], withProvenance = true): CompanyMatchingContext => ({
  restrictions,
  provenance: new ProvenanceIndex(withProvenance ? restrictions.map((r) => prov(r.id)) : []),
  asOfDate: "2026-12-15",
});
const criterio = (company: CompanyMatchingContext | undefined) => engine.score(tender, profile, company).eligibility.criteria.find((c) => c.requirement === "restrictions");

describe("elegibilidad por restricciones de la empresa", () => {
  it("sin contexto o sin restricciones capturadas el motor se comporta como siempre (no agrega criterio)", () => {
    expect(criterio(undefined)).toBeUndefined();
    expect(engine.score(tender, profile, ctx([])).eligibility.criteria).toEqual([]);
  });

  it("una sancion o inhabilitacion vigente, aprobada y CON procedencia: no_cumple (y no filtra el texto de la restriccion)", () => {
    for (const kind of ["sancion", "inhabilitacion"] as const) {
      const c = criterio(ctx([restr({ kind })]))!;
      expect(c.status).toBe("no_cumple");
      expect(c.explanation).not.toContain("texto interno");
    }
    expect(engine.score(tender, profile, ctx([restr()])).eligibility.status).toBe("no_cumple");
  });

  it("aprobada pero SIN procedencia: no_evaluable con el motivo, nunca no_cumple ni cumple", () => {
    const c = criterio(ctx([restr()], false))!;
    expect(c.status).toBe("no_evaluable");
    expect(c.explanation).toMatch(/procedencia/);
  });

  it("pendiente de aprobacion: no_evaluable; rechazada: se ignora", () => {
    expect(criterio(ctx([restr({ approvalStatus: "pendiente_aprobacion" })]))!.status).toBe("no_evaluable");
    expect(criterio(ctx([restr({ approvalStatus: "rechazado" })]))).toBeUndefined();
  });

  it("conflicto de interes u otra: requiere revision humana (no_evaluable)", () => {
    for (const kind of ["conflicto_interes", "otra"] as const) expect(criterio(ctx([restr({ kind })]))!.status).toBe("no_evaluable");
  });

  it("vigencia a la fecha del acto: vencida o aun no vigente no cuenta -> cumple; el ultimo dia sigue vigente", () => {
    expect(criterio(ctx([restr({ validUntil: "2026-12-14" })]))!.status).toBe("cumple");
    expect(criterio(ctx([restr({ validFrom: "2026-12-16" })]))!.status).toBe("cumple");
    expect(criterio(ctx([restr({ validUntil: "2026-12-15" })]))!.status).toBe("no_cumple");
  });

  it("no cambia el score: solo la elegibilidad", () => {
    const base = engine.score(tender, toOrganizationMatchingProfile({ organizationId: "org-1", keywords: ["mantenimiento"], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null, updatedBy: null, updatedAt: "x" }, "org-1"));
    const con = engine.score(tender, toOrganizationMatchingProfile({ organizationId: "org-1", keywords: ["mantenimiento"], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null, updatedBy: null, updatedAt: "x" }, "org-1"), ctx([restr()]));
    expect(con.score).toBe(base.score);
  });
});

describe("hash de insumos del go/no-go", () => {
  it("sin restricciones el hash es el de siempre; con restricciones cambia, y tambien si cambia su procedencia", () => {
    const sin = computeMatchInputsHash(buildMatchInputsSnapshot(tender, null));
    expect(computeMatchInputsHash(buildMatchInputsSnapshot(tender, null, ctx([])))).toBe(sin);
    const con = computeMatchInputsHash(buildMatchInputsSnapshot(tender, null, ctx([restr()])));
    expect(con).not.toBe(sin);
    expect(computeMatchInputsHash(buildMatchInputsSnapshot(tender, null, ctx([restr()], false)))).not.toBe(con);
  });
});

describe("contexto desde el repositorio", () => {
  it("fecha del acto = dia de la fecha limite en hora de Mexico; sin fecha limite, hoy", () => {
    expect(matchingAsOfDate({ submissionDeadline: "2026-12-15T18:00:00-06:00" }, "2030-01-01")).toBe("2026-12-15");
    expect(matchingAsOfDate({ submissionDeadline: "2026-12-16T05:59:00Z" }, "2030-01-01")).toBe("2026-12-15");
    expect(matchingAsOfDate({ submissionDeadline: null }, "2030-01-01")).toBe("2030-01-01");
  });

  it("null sin restricciones; con restricciones trae la procedencia real del repositorio (un dato sin procedencia sale sin ella)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    expect(await loadCompanyMatchingContext(repo, "org-1", tender)).toBeNull();
    const creada = await repo.createCompanyRestriction("org-1", { kind: "sancion", description: "x", validFrom: "2026-01-01", actorId: "u1" });
    const conProcedencia = (await loadCompanyMatchingContext(repo, "org-1", tender))!;
    expect(conProcedencia.provenance.has("restriction", creada.id)).toBe(true);
    repo.companyProfile.forgetProvenance("org-1", "restriction", creada.id);
    const sinProcedencia = (await loadCompanyMatchingContext(repo, "org-1", tender))!;
    expect(sinProcedencia.provenance.has("restriction", creada.id)).toBe(false);
    expect(engine.score(tender, profile, sinProcedencia).eligibility.status).toBe("no_evaluable");
  });
});
