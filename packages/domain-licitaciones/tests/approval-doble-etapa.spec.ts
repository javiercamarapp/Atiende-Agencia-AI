// L-26 (REQ-044) -- doble aprobacion del expediente: tecnico-legal (1/2) y economica (2/2),
// por DOS personas distintas, ambas para el MISMO hash de insumos. Reglas puras de dominio;
// la persistencia (SQL real) la cubre scripts/verify-licitaciones-doble-aprobacion.
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, EXPEDIENTE_APPROVAL_STAGES, evaluateExpedienteStages, isExpedienteApprovalStage, resetApprovalCounters } from "../src/approval-workflow.ts";
import type { Approval } from "../src/approval-workflow.ts";
import { ApprovalRejectedError, ExpedienteStageNotAvailableError } from "../src/errors.ts";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";

const V1: ExpedienteInputs = { tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };
const V2: ExpedienteInputs = { tenderVersionHash: "tv2", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };

function approve(wf: ApprovalWorkflow, actorId: string, stage: "tecnica_legal" | "economica", inputs: ExpedienteInputs = V1, role: "owner" | "admin" | "analyst" = "owner"): Approval {
  return wf.approve({ scope: "expediente", scopeRef: "expediente", actorId, actorRole: role, inputsHash: sealInputs(inputs), stage });
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApprovalRejectedError) return err.reasonCode;
    throw err;
  }
  return "no_lanzo";
}

beforeEach(() => resetApprovalCounters());

describe("etapas de la doble aprobacion (dominio)", () => {
  it("expone exactamente las dos etapas y su guarda de tipo", () => {
    expect([...EXPEDIENTE_APPROVAL_STAGES]).toEqual(["tecnica_legal", "economica"]);
    expect(isExpedienteApprovalStage("economica")).toBe(true);
    expect(isExpedienteApprovalStage("final")).toBe(false);
    expect(isExpedienteApprovalStage(undefined)).toBe(false);
  });

  it("camino feliz: dos personas distintas completan el 2/2 para el mismo hash", () => {
    const wf = new ApprovalWorkflow();
    const tl = approve(wf, "u1", "tecnica_legal");
    expect(tl.stage).toBe("tecnica_legal");
    const ec = approve(wf, "u2", "economica", V1, "analyst");
    expect(ec.stage).toBe("economica");
    const ev = evaluateExpedienteStages(wf.listApprovals(), sealInputs(V1).hash);
    expect(ev.complete).toBe(true);
    expect(ev.missing).toEqual([]);
  });

  it("la economica exige la tecnico-legal vigente (409 de negocio: tecnica_legal_requerida_para_economica)", () => {
    const wf = new ApprovalWorkflow();
    expect(reasonOf(() => approve(wf, "u2", "economica"))).toBe("tecnica_legal_requerida_para_economica");
  });

  it("la economica exige la tecnico-legal para el MISMO hash: una 1/2 de insumos viejos no cuenta", () => {
    const wf = new ApprovalWorkflow();
    approve(wf, "u1", "tecnica_legal", V1);
    expect(reasonOf(() => approve(wf, "u2", "economica", V2))).toBe("tecnica_legal_requerida_para_economica");
  });

  it("la misma persona no puede dar las dos etapas (doble_aprobacion_mismo_actor), tecnico-legal primero", () => {
    const wf = new ApprovalWorkflow();
    approve(wf, "u1", "tecnica_legal");
    expect(reasonOf(() => approve(wf, "u1", "economica"))).toBe("doble_aprobacion_mismo_actor");
  });

  it("tampoco en el orden inverso: quien dio la economica no puede re-dar la tecnico-legal", () => {
    const wf = new ApprovalWorkflow();
    approve(wf, "u1", "tecnica_legal");
    approve(wf, "u2", "economica", V1, "analyst");
    expect(reasonOf(() => approve(wf, "u2", "tecnica_legal", V1, "analyst"))).toBe("doble_aprobacion_mismo_actor");
  });

  it("la etapa solo existe para el alcance expediente", () => {
    const wf = new ApprovalWorkflow();
    expect(
      reasonOf(() => wf.approve({ scope: "seccion", scopeRef: "seccion:technical:tecnica", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(V1), stage: "tecnica_legal" })),
    ).toBe("etapa_solo_para_expediente");
  });

  it("un rol sin decision no aprueba ninguna etapa (antes que cualquier regla de etapa)", () => {
    const wf = new ApprovalWorkflow();
    expect(
      reasonOf(() => wf.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "writer", inputsHash: sealInputs(V1), stage: "tecnica_legal" })),
    ).toBe("rol_no_autorizado_para_aprobar");
  });

  it("AE-11 sigue vigente por etapa: un autor de contenido de cualquier seccion no aprueba ninguna etapa", () => {
    const wf = new ApprovalWorkflow({ sectionAuthors: new Map([["seccion:economic:carta", new Set(["u1"])]]) });
    expect(reasonOf(() => approve(wf, "u1", "tecnica_legal"))).toBe("autoaprobacion_prohibida_actor_autor_de_contenido_en_alcance_cubierto");
  });

  it("cualquier cambio de insumos invalida AMBAS etapas y el 2/2 deja de estar completo", () => {
    const wf = new ApprovalWorkflow();
    approve(wf, "u1", "tecnica_legal");
    approve(wf, "u2", "economica", V1, "analyst");
    wf.recordChange({ scope: "expediente", scopeRef: "expediente", reason: "insumo_cambiado:tarifa" });
    const ev = evaluateExpedienteStages(wf.listApprovals(), sealInputs(V1).hash);
    expect(ev.complete).toBe(false);
    expect(ev.missing).toEqual(["tecnica_legal", "economica"]);
  });
});

describe("evaluateExpedienteStages", () => {
  const h1 = sealInputs(V1).hash;
  const base = { scope: "expediente", scopeRef: "expediente", approvedByRole: "owner", approvedAt: "2026-10-01T00:00:00.000Z", status: "vigente" } as const;

  it("una aprobacion unica anterior (sin etapa) NO cuenta para el 2/2", () => {
    const legacy: Approval = { ...base, id: "a", approvedBy: "u1", inputsHash: h1 };
    const ev = evaluateExpedienteStages([legacy], h1);
    expect(ev.complete).toBe(false);
    expect(ev.missing).toEqual(["tecnica_legal", "economica"]);
  });

  it("con solo la 1/2 falta exactamente la economica", () => {
    const tl: Approval = { ...base, id: "a", approvedBy: "u1", inputsHash: h1, stage: "tecnica_legal" };
    const ev = evaluateExpedienteStages([tl], h1);
    expect(ev.complete).toBe(false);
    expect(ev.missing).toEqual(["economica"]);
    expect(ev.tecnicaLegal?.id).toBe("a");
  });

  it("defensa en profundidad: dos etapas de la misma persona no completan el 2/2", () => {
    const tl: Approval = { ...base, id: "a", approvedBy: "u1", inputsHash: h1, stage: "tecnica_legal" };
    const ec: Approval = { ...base, id: "b", approvedBy: "u1", inputsHash: h1, stage: "economica" };
    const ev = evaluateExpedienteStages([tl, ec], h1);
    expect(ev.sameApprover).toBe(true);
    expect(ev.complete).toBe(false);
  });

  it("aprobaciones invalidadas o con otro hash no cuentan", () => {
    const tl: Approval = { ...base, id: "a", approvedBy: "u1", inputsHash: h1, stage: "tecnica_legal" };
    const ecOld: Approval = { ...base, id: "b", approvedBy: "u2", inputsHash: sealInputs(V2).hash, stage: "economica" };
    const ecInv: Approval = { ...base, id: "c", approvedBy: "u2", inputsHash: h1, stage: "economica", status: "invalidada" };
    expect(evaluateExpedienteStages([tl, ecOld, ecInv], h1).missing).toEqual(["economica"]);
  });
});

describe("InMemoryLicitacionesRepository -- doble aprobacion", () => {
  const ORG = "org-1";
  async function seed() {
    const repo = new InMemoryLicitacionesRepository();
    repo.seedTender({ id: "tender-1", organizationId: ORG, title: "Convocatoria de prueba", submissionDeadline: "2026-12-01T18:00:00-06:00", updatedAt: "2026-01-01T00:00:00Z" });
    const proposal = await repo.getOrCreateProposal(ORG, "tender-1", "user-1", "Propuesta");
    return { repo, proposalId: proposal.id };
  }
  const stageInput = (actorId: string, stage: "tecnica_legal" | "economica", inputs: ExpedienteInputs = V1) => ({
    scope: "expediente" as const,
    scopeRef: "expediente",
    actorId,
    actorRole: "owner" as const,
    inputsHash: sealInputs(inputs),
    stage,
  });

  it("persiste las dos etapas por separado: re-aprobar una etapa solo supersede a esa etapa", async () => {
    const { repo, proposalId } = await seed();
    const tl1 = await repo.approve(ORG, proposalId, stageInput("u1", "tecnica_legal"));
    const ec = await repo.approve(ORG, proposalId, stageInput("u2", "economica"));
    const tl2 = await repo.approve(ORG, proposalId, stageInput("u3", "tecnica_legal"));
    const { mode, approvals } = await repo.listExpedienteStageApprovals(ORG, proposalId);
    expect(mode).toBe("doble");
    expect(approvals.map((a) => `${a.stage}:${a.id}`).sort()).toEqual([`economica:${ec.id}`, `tecnica_legal:${tl2.id}`].sort());
    expect(approvals.some((a) => a.id === tl1.id)).toBe(false);
  });

  it("rechaza la economica sin tecnico-legal y la misma persona en las dos etapas (reglas del dominio, via repositorio)", async () => {
    const { repo, proposalId } = await seed();
    await expect(repo.approve(ORG, proposalId, stageInput("u2", "economica"))).rejects.toThrow(ApprovalRejectedError);
    await repo.approve(ORG, proposalId, stageInput("u1", "tecnica_legal"));
    await expect(repo.approve(ORG, proposalId, stageInput("u1", "economica"))).rejects.toThrow(ApprovalRejectedError);
  });

  it("un cambio de insumos (recordChange) invalida ambas etapas", async () => {
    const { repo, proposalId } = await seed();
    await repo.approve(ORG, proposalId, stageInput("u1", "tecnica_legal"));
    await repo.approve(ORG, proposalId, stageInput("u2", "economica"));
    await repo.recordChange(ORG, proposalId, { scope: "expediente", scopeRef: "expediente", reason: "insumo_cambiado:tarifa" });
    expect((await repo.listExpedienteStageApprovals(ORG, proposalId)).approvals).toEqual([]);
  });

  it("base sin migrar (modo legacy): las filas llegan sin etapa, aprobar CON etapa lanza ExpedienteStageNotAvailableError y la aprobacion unica sigue funcionando", async () => {
    const { repo, proposalId } = await seed();
    repo.setExpedienteStageMode("legacy");
    await expect(repo.approve(ORG, proposalId, stageInput("u1", "tecnica_legal"))).rejects.toBeInstanceOf(ExpedienteStageNotAvailableError);
    const single = await repo.approve(ORG, proposalId, { scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(V1) });
    const snapshot = await repo.listExpedienteStageApprovals(ORG, proposalId);
    expect(snapshot.mode).toBe("legacy");
    expect(snapshot.approvals.map((a) => a.id)).toEqual([single.id]);
    expect(snapshot.approvals[0]!.stage).toBeUndefined();
  });

  it("nunca cruza organizaciones", async () => {
    const { repo, proposalId } = await seed();
    await expect(repo.listExpedienteStageApprovals("otra-org", proposalId)).rejects.toThrow();
  });
});
