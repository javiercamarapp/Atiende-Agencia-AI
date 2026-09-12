// Fase 2 pieza 3 -- TechnicalProposalBuilder. Solo redacta con datos de
// empresa en estado 'aprobado'; cada afirmación lleva un SourceRef trazable.
// Dato faltante o no-aprobado -> SectionBlocker explícito, NUNCA relleno
// inventado.
import { describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.ts";
import type { CompanyDocument } from "../src/company-data.ts";
import { TechnicalProposalBuilder, isNotApplicableSection, extractNotApplicableRequirements } from "../src/technical-proposal.ts";
import type { RequirementFulfillmentMapping } from "../src/technical-proposal.ts";
import type { RequirementItem } from "../src/requirement-matrix.ts";

const AS_OF = "2026-06-01T00:00:00-06:00";
const COMPANY_ID = "empresa-1";

function baseRequirement(overrides: Partial<RequirementItem> = {}): RequirementItem {
  return {
    id: "req-1",
    text: "El licitante deberá presentar acta constitutiva vigente.",
    source: { documentId: "bases", documentLabel: "Bases", page: 3 },
    obligatoriedad: "obligatorio",
    type: "legal",
    responsibleRole: "legal",
    deadline: null,
    requiredEvidence: ["acta_constitutiva"],
    status: "pendiente",
    extractedBy: "rule",
    ...overrides,
  };
}

function mappingFor(requirementId: string): RequirementFulfillmentMapping {
  return {
    requirementId,
    kind: "document",
    refKey: "acta_constitutiva",
    statementText: (value) => `Se acompaña acta constitutiva vigente (documento "${(value as CompanyDocument).label}").`,
  };
}

describe("TechnicalProposalBuilder -- solo redacta con datos APROBADOS, trazables", () => {
  it("un documento de empresa APROBADO y vigente produce un ProposalStatement con SourceRef trazable", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [{ id: "doc-1", companyId: COMPANY_ID, type: "acta_constitutiva", label: "Acta Constitutiva S.A.", issuedAt: "2020-01-01T00:00:00-06:00", expiresAt: null, approvalStatus: "aprobado" }],
    });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement();
    const result = builder.build(COMPANY_ID, [requirement], [mappingFor(requirement.id)], AS_OF);

    expect(result.blockers).toEqual([]);
    expect(result.sections.length).toBe(1);
    const [section] = result.sections;
    expect(section!.statements.length).toBe(1);
    expect(section!.statements[0]!.sourceRef).toEqual({ kind: "company_data", refId: "doc-1", capturedAt: "2020-01-01T00:00:00-06:00" });
    expect(section!.statements[0]!.text).toContain("Acta Constitutiva S.A.");
  });

  it("un documento de empresa VENCIDO a la fecha del acto produce SectionBlocker, nunca texto generado con ese dato", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [{ id: "doc-1", companyId: COMPANY_ID, type: "acta_constitutiva", label: "Acta vencida", issuedAt: "2020-01-01T00:00:00-06:00", expiresAt: "2026-01-01T00:00:00-06:00", approvalStatus: "aprobado" }],
    });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement();
    const result = builder.build(COMPANY_ID, [requirement], [mappingFor(requirement.id)], AS_OF);

    expect(result.sections[0]!.statements).toEqual([]);
    expect(result.sections[0]!.blockers.length).toBe(1);
    expect(result.sections[0]!.blockers[0]!.status).toBe("blocked");
    expect(result.blockers[0]!.detail).toContain("venció");
  });

  it("un documento NO aprobado (pendiente_aprobacion) produce SectionBlocker, nunca se usa igual", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [{ id: "doc-1", companyId: COMPANY_ID, type: "acta_constitutiva", label: "Acta sin aprobar", issuedAt: "2020-01-01T00:00:00-06:00", expiresAt: null, approvalStatus: "pendiente_aprobacion" }],
    });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement();
    const result = builder.build(COMPANY_ID, [requirement], [mappingFor(requirement.id)], AS_OF);

    expect(result.sections[0]!.statements).toEqual([]);
    expect(result.sections[0]!.blockers[0]!.detail).toContain("no \"aprobado\"");
  });

  it("un dato de empresa completamente ausente produce 'missing', no un texto vacío ni inventado", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement();
    const result = builder.build(COMPANY_ID, [requirement], [mappingFor(requirement.id)], AS_OF);

    expect(result.sections[0]!.blockers[0]!.status).toBe("missing");
    expect(result.sections[0]!.blockers[0]!.detail).toContain("Falta el dato");
  });

  it("un requisito OBLIGATORIO sin mapeo declarado NUNCA se omite en silencio -- sección PENDIENTE explícita", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement();
    const result = builder.build(COMPANY_ID, [requirement], [], AS_OF); // sin mappings

    expect(result.sections.length).toBe(1);
    expect(result.sections[0]!.blockers[0]!.field).toBe("mapeo_no_declarado");
  });

  it("un requisito OPCIONAL sin evidencia mapeable genera una sección visible 'NO APLICA', nunca desaparece sin rastro", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement({ obligatoriedad: "opcional", requiredEvidence: [] });
    const result = builder.build(COMPANY_ID, [requirement], [], AS_OF);

    expect(result.sections.length).toBe(1);
    expect(isNotApplicableSection(result.sections[0]!)).toBe(true);
    expect(result.sections[0]!.blockers).toEqual([]);
    expect(extractNotApplicableRequirements(result)).toEqual([{ requirementId: requirement.id, reason: "requisito opcional" }]);
  });

  it("un requisito CONDICIONAL sin evidencia y SIN declaración explícita de aplicabilidad es fail-closed: 'no_evaluable', tratado como obligatorio", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement({ obligatoriedad: "condicional", requiredEvidence: [] });
    const result = builder.build(COMPANY_ID, [requirement], [], AS_OF); // conditionEvaluations vacío -> no evaluado

    expect(isNotApplicableSection(result.sections[0]!)).toBe(false);
    expect(result.sections[0]!.blockers[0]!.field).toBe("condicion_no_evaluable");
  });

  it("un requisito CONDICIONAL declarado explícitamente como NO aplicable (false) genera sección 'NO APLICA'", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement({ obligatoriedad: "condicional", requiredEvidence: [], topicKey: "anuncio_plazo" });
    const result = builder.build(COMPANY_ID, [requirement], [], AS_OF, { [requirement.id]: false });

    expect(isNotApplicableSection(result.sections[0]!)).toBe(true);
  });

  it("un requisito con conflicto sin resolver (status 'bloqueado') NUNCA se redacta -- sección bloqueada explícita", () => {
    const resolver = new InMemoryCompanyDataResolver({
      documents: [{ id: "doc-1", companyId: COMPANY_ID, type: "acta_constitutiva", label: "Acta", issuedAt: "2020-01-01T00:00:00-06:00", expiresAt: null, approvalStatus: "aprobado" }],
    });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement({ status: "bloqueado" });
    const result = builder.build(COMPANY_ID, [requirement], [mappingFor(requirement.id)], AS_OF);

    expect(result.sections[0]!.statements).toEqual([]);
    expect(result.sections[0]!.blockers[0]!.status).toBe("blocked");
    expect(result.sections[0]!.blockers[0]!.detail).toContain("conflicto abierto");
  });

  it("requisitos de tipo 'economico' quedan fuera del alcance de la propuesta TÉCNICA (los cubre el motor económico, Flujo 2)", () => {
    const resolver = new InMemoryCompanyDataResolver({ documents: [] });
    const builder = new TechnicalProposalBuilder(new CompanyDataService(resolver));
    const requirement = baseRequirement({ type: "economico" });
    const result = builder.build(COMPANY_ID, [requirement], [], AS_OF);
    expect(result.sections).toEqual([]);
  });
});
