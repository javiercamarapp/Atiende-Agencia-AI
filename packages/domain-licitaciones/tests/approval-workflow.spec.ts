// Fase 2 pieza 1 -- máquina de aprobaciones granular (AE-02/AE-11), la deuda
// que el propio Fase 1 dejó explícitamente señalizada en la cabecera de
// `expediente-approval.ts` (ya reemplazado por este módulo). Estos tests
// calcan los escenarios que el repo origen documenta como los que corrigieron
// vulnerabilidades reales (autoaprobación de quien redactó el contenido que
// se está "revisando").
import { beforeEach, describe, expect, it } from "vitest";
import { ApprovalWorkflow, resetApprovalCounters } from "../src/approval-workflow.ts";
import { ApprovalRejectedError } from "../src/errors.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";

const INPUTS_V1: ExpedienteInputs = { tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };
const INPUTS_V2: ExpedienteInputs = { tenderVersionHash: "tv2", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };

beforeEach(() => {
  resetApprovalCounters();
});

describe("ApprovalWorkflow.approve -- rol", () => {
  it("rechaza approve() de un rol que no está en APPROVER_ROLES (writer/reviewer/viewer nunca aprueban -- APPROVER_ROLES === DECISION_ROLES)", () => {
    const workflow = new ApprovalWorkflow();
    for (const role of ["writer", "reviewer", "viewer"] as const) {
      expect(() => workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: role, inputsHash: sealInputs(INPUTS_V1) })).toThrow(ApprovalRejectedError);
    }
  });

  it("permite approve() a owner/admin/analyst (DECISION_ROLES) -- mismo conjunto que assertVerticalRole(c, DECISION_ROLES) ya exige a nivel de ruta", () => {
    for (const role of ["owner", "admin", "analyst"] as const) {
      const workflow = new ApprovalWorkflow();
      const approval = workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: role, inputsHash: sealInputs(INPUTS_V1) });
      expect(approval.status).toBe("vigente");
    }
  });
});

describe("ApprovalWorkflow.approve -- AE-02 (scope/scopeRef consistentes)", () => {
  it('scope:"expediente" con scopeRef distinto de "expediente" se rechaza', () => {
    const workflow = new ApprovalWorkflow();
    expect(() =>
      workflow.approve({ scope: "expediente", scopeRef: "seccion:tecnica", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) }),
    ).toThrow(ApprovalRejectedError);
  });

  it('scope:"seccion" con su propio scopeRef ("seccion:x") se acepta con normalidad', () => {
    const workflow = new ApprovalWorkflow();
    const approval = workflow.approve({ scope: "seccion", scopeRef: "seccion:tecnica", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(approval.scopeRef).toBe("seccion:tecnica");
  });
});

describe("ApprovalWorkflow.approve -- autoaprobación por submitter", () => {
  it("quien envió un alcance a revisión (requestReview) no puede aprobar ese mismo alcance", () => {
    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "u1", actorRole: "writer" });
    expect(() => workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) })).toThrow(ApprovalRejectedError);
  });

  it("una persona DISTINTA de quien pidió la revisión sí puede aprobar", () => {
    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "u1", actorRole: "writer" });
    const approval = workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u2", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(approval.status).toBe("vigente");
  });

  it("requestReview rechaza actores sin rol de SUBMITTER_ROLES (reviewer/viewer no envían a revisión)", () => {
    const workflow = new ApprovalWorkflow();
    expect(() => workflow.requestReview({ scopeRef: "expediente", actorId: "u1", actorRole: "viewer" })).toThrow(ApprovalRejectedError);
  });
});

describe("ApprovalWorkflow.approve -- AE-11 (autoaprobación por autoría de contenido)", () => {
  it("el actor que redactó (recordEdit) una sección no puede aprobar el EXPEDIENTE COMPLETO, aunque OTRA persona haya pedido la revisión", () => {
    const workflow = new ApprovalWorkflow();
    workflow.requestReview({ scopeRef: "expediente", actorId: "u-otro", actorRole: "writer" });
    workflow.recordEdit({ scopeRef: "seccion:tecnica", actorId: "u1" });

    expect(() => workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) })).toThrow(ApprovalRejectedError);
  });

  it("el actor que redactó una sección tampoco puede aprobar ESA MISMA sección", () => {
    const workflow = new ApprovalWorkflow();
    workflow.recordEdit({ scopeRef: "seccion:tecnica", actorId: "u1" });
    expect(() => workflow.approve({ scope: "seccion", scopeRef: "seccion:tecnica", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) })).toThrow(ApprovalRejectedError);
  });

  it("el actor que redactó la sección A SÍ puede aprobar la sección B (secciones hermanas independientes)", () => {
    const workflow = new ApprovalWorkflow();
    workflow.recordEdit({ scopeRef: "seccion:a", actorId: "u1" });
    const approval = workflow.approve({ scope: "seccion", scopeRef: "seccion:b", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(approval.status).toBe("vigente");
  });

  it("una persona que nunca redactó nada SÍ puede aprobar el expediente completo", () => {
    const workflow = new ApprovalWorkflow();
    workflow.recordEdit({ scopeRef: "seccion:tecnica", actorId: "u1" });
    workflow.recordEdit({ scopeRef: "seccion:economica", actorId: "u2" });
    const approval = workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u3", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(approval.status).toBe("vigente");
  });
});

describe("ApprovalWorkflow -- EX-EXP-17 (regresión ya portada Fase 1): requireValidHashedInputs sigue siendo fail-closed dentro de approve()", () => {
  it("rechaza un inputsHash pasado como string plano, incluso si es el hash 'correcto' calculado por fuera", () => {
    const workflow = new ApprovalWorkflow();
    const handCalculated = sealInputs(INPUTS_V1).hash;
    expect(() =>
      workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: handCalculated as unknown as ReturnType<typeof sealInputs> }),
    ).toThrow(/STRING PLANO/);
  });
});

describe("ApprovalWorkflow.recordChange -- invalidación por alcance", () => {
  it("invalida solo las aprobaciones vigentes que cubren el scopeRef afectado, nunca las de una sección hermana", () => {
    const workflow = new ApprovalWorkflow();
    const approvalA = workflow.approve({ scope: "seccion", scopeRef: "seccion:a", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    const approvalB = workflow.approve({ scope: "seccion", scopeRef: "seccion:b", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });

    const change = workflow.recordChange({ scope: "seccion", scopeRef: "seccion:a", reason: "insumo_cambiado:rate:x" });

    expect(change.invalidatedApprovalIds).toEqual([approvalA.id]);
    expect(workflow.activeApprovalsCovering("seccion:a")).toEqual([]);
    expect(workflow.activeApprovalsCovering("seccion:b").map((a) => a.id)).toEqual([approvalB.id]);
  });

  it("un cambio de alcance 'expediente' invalida SOLO la aprobación de 'expediente' (no es ancestro de las secciones, es al revés)", () => {
    const workflow = new ApprovalWorkflow();
    const approvalSection = workflow.approve({ scope: "seccion", scopeRef: "seccion:a", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u2", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });

    const change = workflow.recordChange({ scope: "expediente", scopeRef: "expediente", reason: "cambio_mayor" });
    expect(change.invalidatedApprovalIds.length).toBe(1);
    expect(workflow.isFullyApproved()).toBe(false);
    // La aprobación de la sección hermana, ajena al cambio, sigue vigente.
    expect(workflow.activeApprovalsCovering("seccion:a").map((a) => a.id)).toEqual([approvalSection.id]);
  });

  it("un cambio en una SECCIÓN invalida también la aprobación de 'expediente' que la cubría", () => {
    const workflow = new ApprovalWorkflow();
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(workflow.isFullyApproved()).toBe(true);

    workflow.recordChange({ scope: "seccion", scopeRef: "seccion:tecnica", reason: "insumo_cambiado:doc:x" });
    expect(workflow.isFullyApproved()).toBe(false);
  });
});

describe("ApprovalWorkflow.revalidateAgainstCurrentHash / isFullyApprovedForCurrentHash", () => {
  it("invalida automáticamente una aprobación de expediente cuyo inputsHash ya no coincide con el hash actual", () => {
    const workflow = new ApprovalWorkflow();
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(workflow.isFullyApprovedForCurrentHash(sealInputs(INPUTS_V1))).toBe(true);
    expect(workflow.isFullyApprovedForCurrentHash(sealInputs(INPUTS_V2))).toBe(false);
    // La invalidación quedó registrada como un ChangeDetected real, no solo un booleano.
    expect(workflow.listChanges().length).toBe(1);
    expect(workflow.listChanges()[0]!.reason).toContain("hash_insumos_divergente");
  });

  it("no genera un ChangeDetected cuando el hash sigue coincidiendo (sin ruido)", () => {
    const workflow = new ApprovalWorkflow();
    workflow.approve({ scope: "expediente", scopeRef: "expediente", actorId: "u1", actorRole: "owner", inputsHash: sealInputs(INPUTS_V1) });
    expect(workflow.isFullyApprovedForCurrentHash(sealInputs(INPUTS_V1))).toBe(true);
    expect(workflow.listChanges()).toEqual([]);
  });
});
