import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { IdempotencyConflictError, ApprovalRejectedError } from "../src/errors.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";

const EMPTY_INPUTS: ExpedienteInputs = { tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };
const OTHER_INPUTS: ExpedienteInputs = { tenderVersionHash: "tv2", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };

const ORG = "org-1";
const TENDER_ID = "tender-1";

function repoWithTender(submissionDeadline: string | null = "2026-12-01T18:00:00-06:00"): InMemoryLicitacionesRepository {
  const repo = new InMemoryLicitacionesRepository();
  repo.seedTender({ id: TENDER_ID, organizationId: ORG, title: "Convocatoria de prueba", submissionDeadline, updatedAt: "2026-01-01T00:00:00Z" });
  return repo;
}

describe("InMemoryLicitacionesRepository -- expediente", () => {
  it("getOrCreateProposal es idempotente por (organizationId, tenderId)", async () => {
    const repo = repoWithTender();
    const first = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const second = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    expect(second.id).toBe(first.id);
  });

  it("findTender nunca cruza organizaciones", async () => {
    const repo = repoWithTender();
    expect(await repo.findTender("otra-org", TENDER_ID)).toBeNull();
  });

  it("listApprovedRates filtra server-side por aprobación y vigencia a asOfIso", async () => {
    const repo = repoWithTender();
    repo.seedApprovedRates(ORG, [
      { id: "r1", concept: "vigente", unitPrice: "10.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null },
      { id: "r2", concept: "vencida", unitPrice: "10.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: "2026-02-01T00:00:00-06:00" },
      { id: "r3", concept: "no_aprobada", unitPrice: "10.00", currency: "MXN", approvalStatus: "pendiente_aprobacion", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null },
    ]);
    const rates = await repo.listApprovedRates(ORG, "2026-06-01T00:00:00-06:00");
    expect(rates.map((r) => r.concept)).toEqual(["vigente"]);
  });
});

describe("InMemoryLicitacionesRepository -- aprobación de expediente (Fase 2 pieza 1)", () => {
  it("approve() invalida cualquier aprobación 'vigente' previa del MISMO scopeRef antes de crear la nueva", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const first = await repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-1", actorRole: "owner", inputsHash: sealInputs(EMPTY_INPUTS) });
    const second = await repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-1", actorRole: "owner", inputsHash: sealInputs(OTHER_INPUTS) });
    const [current] = await repo.activeApprovalsCovering(ORG, proposal.id, "expediente");
    expect(current!.id).toBe(second.id);
    expect(current!.inputsHash).toBe(sealInputs(OTHER_INPUTS).hash);
    expect(first.id).not.toBe(second.id);
  });

  it("approve() rechaza rol no autorizado (writer/viewer nunca aprueban)", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    await expect(repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-1", actorRole: "writer", inputsHash: sealInputs(EMPTY_INPUTS) })).rejects.toThrow(ApprovalRejectedError);
  });

  it("AE-11: el actor que redactó una sección no puede aprobar el expediente completo aunque tenga rol de aprobador", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    // "user-2" redacta contenido económico -> queda registrado como autor de "seccion:economic:carta".
    await repo.saveEconomicGeneration(ORG, proposal.id, { actorId: "user-2", economicTotals: { total: "1.00" }, generationReportPatch: {}, correlationId: null, cartaSection: { content: "texto", sources: [] } });
    await expect(
      repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-2", actorRole: "owner", inputsHash: sealInputs(EMPTY_INPUTS) }),
    ).rejects.toThrow(ApprovalRejectedError);
    // Una persona distinta, que no redactó nada, sí puede aprobar.
    await expect(
      repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-3", actorRole: "owner", inputsHash: sealInputs(EMPTY_INPUTS) }),
    ).resolves.toBeDefined();
  });

  it("recordChange invalida solo las aprobaciones que cubren el scopeRef afectado, nunca las de una sección hermana", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const seccionA = await repo.approve(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:a", actorId: "user-1", actorRole: "owner", inputsHash: sealInputs(EMPTY_INPUTS) });
    const seccionB = await repo.approve(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:b", actorId: "user-1", actorRole: "owner", inputsHash: sealInputs(EMPTY_INPUTS) });

    await repo.recordChange(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:a", reason: "insumo_cambiado:rate:x" });

    const [coveringA] = await repo.activeApprovalsCovering(ORG, proposal.id, "seccion:a");
    const [coveringB] = await repo.activeApprovalsCovering(ORG, proposal.id, "seccion:b");
    expect(coveringA).toBeUndefined();
    expect(coveringB!.id).toBe(seccionB.id);
    expect(seccionA.id).not.toBe(seccionB.id);
  });
});

describe("InMemoryLicitacionesRepository -- idempotencia", () => {
  it("la misma Idempotency-Key con el mismo cuerpo devuelve el resultado ya calculado, sin re-ejecutar", async () => {
    const repo = repoWithTender();
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.resolve({ status: 201, body: { ok: true } });
    };
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    expect(calls).toBe(1);
  });

  it("la misma Idempotency-Key con un cuerpo DISTINTO lanza IdempotencyConflictError", async () => {
    const repo = repoWithTender();
    const run = () => Promise.resolve({ status: 201, body: { ok: true } });
    await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 1 } }, run);
    await expect(repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k1", body: { a: 2 } }, run)).rejects.toThrow(IdempotencyConflictError);
  });

  // Fix hallazgo auditoría (rubro 2, "Idempotency-Key queda envenenada ante error
  // no-Postgres") — mismo fix/misma regresión que domain-hoteles: un error de
  // `run()` nunca debe dejar la key envenenada para siempre.
  it("run() lanzando un error NUNCA envenena la key -- un reintento legítimo después SÍ completa", async () => {
    const repo = repoWithTender();
    let intentos = 0;
    const run = async () => {
      intentos += 1;
      if (intentos === 1) throw new Error("conector externo no disponible (timeout)");
      return { status: 201, body: { ok: true } };
    };

    await expect(repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k2", body: { a: 1 } }, run)).rejects.toThrow(
      "conector externo no disponible",
    );

    // Antes del fix, este segundo intento lanzaba "La solicitud original con este
    // Idempotency-Key aún no terminó de procesarse." para siempre.
    const result = await repo.withIdempotency({ organizationId: ORG, scope: "checklist.run", key: "k2", body: { a: 1 } }, run);
    expect(result).toEqual({ status: 201, body: { ok: true } });
    expect(intentos).toBe(2);
  });
});

describe("InMemoryLicitacionesRepository -- computeCurrentInputsHash", () => {
  it("produce un HashedInputs sellado y determinista para el mismo estado", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const a = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const b = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(a.hash).toBe(b.hash);
  });

  it("el hash cambia cuando cambia una tarifa realmente usada en generation_report.economic.usedRateConcepts", async () => {
    const repo = repoWithTender();
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const before = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);

    await repo.saveEconomicGeneration(ORG, proposal.id, { actorId: "user-1", economicTotals: { total: "500.00" }, generationReportPatch: { usedRateConcepts: ["consultoria_hora"], blockedLineItems: [], totals: { total: "500.00" } }, correlationId: null });
    const afterUsingRate = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(afterUsingRate.hash).not.toBe(before.hash);

    // Cambia la tarifa realmente usada -> el hash de insumos debe reflejarlo.
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "999.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const afterRateChanged = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    expect(afterRateChanged.hash).not.toBe(afterUsingRate.hash);
  });
});

describe("InMemoryLicitacionesRepository -- syncExpedienteApprovalWithCurrentHash (Fase 2 piezas 1+2 combinadas)", () => {
  it("registra una nueva proposal_version solo cuando el hash combinado CAMBIA, nunca en cada lectura", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const { hash, raw } = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const sealed = sealInputs(raw as ExpedienteInputs);
    expect(sealed.hash).toBe(hash);

    await repo.syncExpedienteApprovalWithCurrentHash(ORG, proposal.id, sealed, raw as ExpedienteInputs);
    await repo.syncExpedienteApprovalWithCurrentHash(ORG, proposal.id, sealed, raw as ExpedienteInputs);
    const version = await repo.latestProposalVersion(ORG, proposal.id);
    expect(version!.version).toBe(1); // segunda llamada con el MISMO hash no crea una versión 2.
  });

  it("invalida la aprobación vigente de 'expediente' con un motivo LEGIBLE que nombra el insumo que cambió, en vez del mensaje opaco de Fase 1", async () => {
    const repo = repoWithTender();
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "500.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    await repo.saveEconomicGeneration(ORG, proposal.id, { actorId: "user-1", economicTotals: { total: "500.00" }, generationReportPatch: { usedRateConcepts: ["consultoria_hora"], blockedLineItems: [], totals: { total: "500.00" } }, correlationId: null });

    const first = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const sealedFirst = sealInputs(first.raw as ExpedienteInputs);
    await repo.syncExpedienteApprovalWithCurrentHash(ORG, proposal.id, sealedFirst, first.raw as ExpedienteInputs);
    await repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "user-2", actorRole: "owner", inputsHash: sealedFirst });

    // Cambia la tarifa realmente usada -> el hash diverge.
    repo.seedApprovedRates(ORG, [{ id: "r1", concept: "consultoria_hora", unitPrice: "999.00", currency: "MXN", approvalStatus: "aprobado", validFrom: "2026-01-01T00:00:00-06:00", validUntil: null }]);
    const second = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const sealedSecond = sealInputs(second.raw as ExpedienteInputs);

    const change = await repo.syncExpedienteApprovalWithCurrentHash(ORG, proposal.id, sealedSecond, second.raw as ExpedienteInputs);
    expect(change).not.toBeNull();
    expect(change!.reason).toBe("insumo_cambiado:rate:consultoria_hora");

    const [current] = await repo.activeApprovalsCovering(ORG, proposal.id, "expediente");
    expect(current).toBeUndefined(); // la aprobación vigente quedó invalidada.
  });

  it("no hace nada (devuelve null, no crea ruido) cuando no hay ninguna aprobación de expediente vigente que invalidar", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    const { raw } = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const sealed = sealInputs(raw as ExpedienteInputs);
    const change = await repo.syncExpedienteApprovalWithCurrentHash(ORG, proposal.id, sealed, raw as ExpedienteInputs);
    expect(change).toBeNull();
  });
});

describe("InMemoryLicitacionesRepository -- Fase 2 pieza 3 (RequirementMatrix / TechnicalProposalBuilder)", () => {
  it("replaceRequirementItems reemplaza TODOS los ítems del tender (mismo criterio de reemplazo completo que replaceComplianceItems)", async () => {
    const repo = repoWithTender();
    await repo.replaceRequirementItems(ORG, TENDER_ID, [
      { id: "req-1", documentId: "bases", text: "x", requirementKind: "legal", obligatoriedad: "obligatorio", topicKey: null, requiredEvidence: [], extractedBy: "rule", page: 1, clause: null, responsibleRole: "legal", deadline: null, status: "pendiente", confidence: 0.7 },
    ]);
    expect((await repo.listRequirementItems(ORG, TENDER_ID)).map((i) => i.id)).toEqual(["req-1"]);

    await repo.replaceRequirementItems(ORG, TENDER_ID, [
      { id: "req-2", documentId: "bases", text: "y", requirementKind: "tecnico", obligatoriedad: "obligatorio", topicKey: null, requiredEvidence: [], extractedBy: "rule", page: 2, clause: null, responsibleRole: "licitador", deadline: null, status: "pendiente", confidence: 0.7 },
    ]);
    expect((await repo.listRequirementItems(ORG, TENDER_ID)).map((i) => i.id)).toEqual(["req-2"]); // req-1 ya no existe.
  });

  it("upsertFulfillmentMapping es idempotente por topicKey (actualiza, no duplica)", async () => {
    const repo = repoWithTender();
    const first = await repo.upsertFulfillmentMapping(ORG, { topicKey: "acta_constitutiva", kind: "document", refKey: "acta_constitutiva", statementTemplate: "Contamos con {value}." });
    const second = await repo.upsertFulfillmentMapping(ORG, { topicKey: "acta_constitutiva", kind: "document", refKey: "acta_constitutiva_v2", statementTemplate: "Se anexa {value}." });
    expect(second.id).toBe(first.id);
    const mappings = await repo.listFulfillmentMappings(ORG);
    expect(mappings.length).toBe(1);
    expect(mappings[0]!.refKey).toBe("acta_constitutiva_v2");
  });

  it("saveTechnicalSections persiste las secciones, patchea generation_report.technical, y dispara AE-11 (section_author) para cada sectionKey", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");

    await repo.saveTechnicalSections(ORG, proposal.id, {
      actorId: "writer-1",
      sections: [{ sectionKey: "technical:legal", label: "Cumplimiento legal", content: "Contamos con acta constitutiva vigente." }],
      usedCompanyDocumentIds: ["doc-1"],
      notApplicableRequirements: [{ requirementId: "req-9", reason: "requisito opcional" }],
    });

    const documents = await repo.loadProposalSectionsAsDocuments(ORG, proposal.id);
    expect(documents.some((d) => d.label === "Cumplimiento legal" && d.content === "Contamos con acta constitutiva vigente.")).toBe(true);

    // AE-11: "writer-1" queda registrado como autor de "seccion:technical:legal"
    // -- no puede aprobar el expediente completo (Pieza 1).
    const { hash, raw } = await repo.computeCurrentInputsHash(ORG, TENDER_ID, proposal.id);
    const sealed = sealInputs(raw as ExpedienteInputs);
    expect(sealed.hash).toBe(hash);
    await expect(repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "writer-1", actorRole: "owner", inputsHash: sealed })).rejects.toThrow(ApprovalRejectedError);
    await expect(repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "otro-usuario", actorRole: "owner", inputsHash: sealed })).resolves.toBeDefined();
  });

  it("saveTechnicalSections una segunda vez para el MISMO sectionKey actualiza el contenido (versión incremental), no crea un documento duplicado", async () => {
    const repo = repoWithTender();
    const proposal = await repo.getOrCreateProposal(ORG, TENDER_ID, "user-1", "Propuesta");
    await repo.saveTechnicalSections(ORG, proposal.id, { actorId: "u1", sections: [{ sectionKey: "technical:legal", label: "Cumplimiento legal", content: "v1" }], usedCompanyDocumentIds: [], notApplicableRequirements: [] });
    await repo.saveTechnicalSections(ORG, proposal.id, { actorId: "u1", sections: [{ sectionKey: "technical:legal", label: "Cumplimiento legal", content: "v2" }], usedCompanyDocumentIds: [], notApplicableRequirements: [] });

    const documents = await repo.loadProposalSectionsAsDocuments(ORG, proposal.id);
    const legalDocs = documents.filter((d) => d.label === "Cumplimiento legal");
    expect(legalDocs.length).toBe(1);
    expect(legalDocs[0]!.content).toBe("v2");
    expect(legalDocs[0]!.version).toBe(2);
  });
});
