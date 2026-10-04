// paridad3 (L-P3-05/06/07) -- repositorio en memoria: matriz estable (upsert por clave, asignaciones manuales
// conservadas, retirados nunca borrados), conflictos persistidos (bloquean el checklist), comentarios solo de adicion y
// editor humano de secciones (AE-02: mismo texto no invalida; AE-11: el autor no aprueba).
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { ApprovalRejectedError, BovedaRevisionNoDisponibleError, RequirementAssigneeNotFoundError } from "../src/errors.ts";
import { IntegrityChecklist } from "../src/integrity-checklist.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import type { ExpedienteInputs } from "../src/sealed-inputs.ts";
import { detectConflicts } from "../src/requirement-matrix.ts";
import type { RequirementItem } from "../src/requirement-matrix.ts";
import type { RequirementUpsertItem } from "../src/repository.ts";

const ORG = "org-1";
const TENDER = "tender-1";
const INPUTS: ExpedienteInputs = { tenderVersionHash: "tv1", companyProfileHash: "cp1", companyDocuments: [], rates: [], templates: [] };
const SCOPE_ALL = { lineageIds: [], includeUnlinked: true } as const;

function repo(): InMemoryLicitacionesRepository {
  const r = new InMemoryLicitacionesRepository();
  r.seedTender({ id: TENDER, organizationId: ORG, title: "Convocatoria", submissionDeadline: "2026-12-01T18:00:00-06:00", updatedAt: "2026-01-01T00:00:00Z" });
  return r;
}

function item(id: string, text: string, over: Partial<RequirementUpsertItem> = {}): RequirementUpsertItem {
  return {
    id,
    documentId: null,
    documentRef: "bases.pdf",
    text,
    requirementKind: "administrativo",
    obligatoriedad: "obligatorio",
    topicKey: null,
    requiredEvidence: [],
    extractedBy: "rule",
    page: 1,
    clause: null,
    responsibleRole: "licitador",
    deadline: null,
    status: "pendiente",
    confidence: null,
    ...over,
  };
}

const OPTS = { actorId: "u1", scope: SCOPE_ALL, retiredInVersion: 2 } as const;

describe("matriz estable (L-P3-06)", () => {
  it("re-extraer el mismo documento actualiza las mismas filas y conserva responsable, estado y asignacion hechos a mano", async () => {
    const r = repo();
    r.seedOrganizationMember(ORG, "u2", "Ana", "writer");
    const first = await r.upsertRequirementItems(ORG, TENDER, [item("req-1", "Presentar acta constitutiva."), item("req-2", "Presentar garantia de seriedad.")], OPTS);
    expect(first).toMatchObject({ mode: "estable", created: 2, updated: 0, retired: 0 });
    const persistedId = first.idByInputId["req-1"]!;

    await r.updateRequirementItem(ORG, TENDER, persistedId, { responsibleRole: "legal", status: "en_progreso", assignedTo: "u2", disqualifying: true }, "u1");

    // Re-extraccion: el extractor vuelve a entregar los mismos requisitos con ids NUEVOS y su valor por defecto.
    const second = await r.upsertRequirementItems(ORG, TENDER, [item("req-77", "Presentar acta constitutiva."), item("req-78", "Presentar garantia de seriedad.")], OPTS);
    expect(second).toMatchObject({ created: 0, retired: 0 });
    expect(second.idByInputId["req-77"]).toBe(persistedId);
    const kept = second.items.find((i) => i.id === persistedId)!;
    expect(kept).toMatchObject({ responsibleRole: "legal", status: "en_progreso", assignedTo: "u2", disqualifying: true });
    expect(kept.manuallyEditedAt).not.toBeNull();
  });

  it("lo que desaparece queda retirado con la version y nunca se borra; el listado normal lo oculta", async () => {
    const r = repo();
    await r.upsertRequirementItems(ORG, TENDER, [item("a", "Requisito A."), item("b", "Requisito B.")], OPTS);
    const second = await r.upsertRequirementItems(ORG, TENDER, [item("a2", "Requisito A.")], OPTS);
    expect(second.retired).toBe(1);

    expect((await r.listRequirementItems(ORG, TENDER)).map((i) => i.text)).toEqual(["Requisito A."]);
    const all = await r.listRequirementMatrix(ORG, TENDER, { includeRetired: true });
    const retired = all.items.find((i) => i.text === "Requisito B.")!;
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.retiredInVersion).toBe(2);
  });

  it("solo retira dentro del alcance extraido: otro documento no se toca", async () => {
    const r = repo();
    await r.upsertRequirementItems(ORG, TENDER, [item("a", "De las bases.", { documentRef: "bases.pdf" }), item("b", "Del anexo.", { documentRef: "anexo.pdf" })], OPTS);
    // Re-extraccion de un solo documento (alcance sin ligados y sin linajes) no retira nada.
    const second = await r.upsertRequirementItems(ORG, TENDER, [], { actorId: "u1", scope: { lineageIds: ["otro"], includeUnlinked: false }, retiredInVersion: 3 });
    expect(second.retired).toBe(0);
    expect((await r.listRequirementItems(ORG, TENDER)).length).toBe(2);
  });

  it("la edicion humana valida que el asignado sea de la organizacion", async () => {
    const r = repo();
    const { idByInputId } = await r.upsertRequirementItems(ORG, TENDER, [item("a", "Requisito A.")], OPTS);
    await expect(r.updateRequirementItem(ORG, TENDER, idByInputId["a"]!, { assignedTo: "extrano" }, "u1")).rejects.toBeInstanceOf(RequirementAssigneeNotFoundError);
    expect(await r.updateRequirementItem(ORG, TENDER, "no-existe", { status: "cumplido" }, "u1")).toBeNull();
  });

  it("base sin la migracion 037: cae al reemplazo con ids reales y pide la migracion para asignar", async () => {
    const r = repo();
    r.boveda037 = false;
    const res = await r.upsertRequirementItems(ORG, TENDER, [item("req-1", "Requisito A.")], OPTS);
    expect(res.mode).toBe("reemplazo");
    await expect(r.updateRequirementItem(ORG, TENDER, res.idByInputId["req-1"]!, { disqualifying: true }, "u1")).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
  });
});

describe("conflictos persistidos (L-P3-06)", () => {
  function twoDeadlines(): RequirementItem[] {
    const mk = (id: string, deadline: string): RequirementItem => ({
      id,
      text: "Entrega de proposiciones.",
      source: { documentId: "d", documentLabel: "d", page: 1 },
      obligatoriedad: "obligatorio",
      type: "administrativo",
      responsibleRole: "licitador",
      deadline,
      requiredEvidence: [],
      status: "pendiente",
      extractedBy: "rule",
      topicKey: "plazo_entrega_proposiciones",
    });
    return [mk("x", "2026-10-01T10:00:00-06:00"), mk("y", "2026-10-02T10:00:00-06:00")];
  }

  async function setup() {
    const r = repo();
    const up = await r.upsertRequirementItems(
      ORG,
      TENDER,
      [item("x", "Entrega uno.", { topicKey: "plazo_entrega_proposiciones", deadline: "2026-10-01T10:00:00-06:00", documentRef: "bases" }), item("y", "Entrega dos.", { topicKey: "plazo_entrega_proposiciones", deadline: "2026-10-02T10:00:00-06:00", documentRef: "acta" })],
      OPTS,
    );
    const [c] = detectConflicts(twoDeadlines());
    const detected = [{ kind: c!.kind, topicKey: c!.topicKey, description: c!.description, itemIds: [up.idByInputId["x"]!, up.idByInputId["y"]!], stableKeys: up.items.map((i) => i.stableKey!) }];
    return { r, up, detected };
  }

  it("persiste el conflicto, es idempotente por huella y bloquea los requisitos con plazo", async () => {
    const { r, detected } = await setup();
    const first = await r.syncRequirementConflicts(ORG, TENDER, detected);
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]!.status).toBe("abierto");
    await r.syncRequirementConflicts(ORG, TENDER, detected);
    expect((await r.listRequirementConflicts(ORG, TENDER)).conflicts).toHaveLength(1);
    expect(await r.countOpenRequirementConflicts(ORG, TENDER)).toBe(1);
    expect((await r.listRequirementMatrix(ORG, TENDER, { includeRetired: false })).items.every((i) => i.status === "bloqueado")).toBe(true);
  });

  it("un conflicto abierto vuelve rojo la consistencia cruzada del checklist; resuelto, ya no", async () => {
    const { r, detected } = await setup();
    const { conflicts } = await r.syncRequirementConflicts(ORG, TENDER, detected);
    const run = (open: number) =>
      new IntegrityChecklist().run({ files: [], formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 1, maxUploadSlots: 1 }, requiredSignatures: [], requiredAnnexes: [], presentAnnexRefs: [], documentsToValidate: [], economicResult: null, crossDocumentTotals: [{ documentLabel: "a", total: "1" }, { documentLabel: "b", total: "1" }], openRequirementConflicts: open }).items.find((i) => i.dimension === "consistencia_cruzada")!;
    expect(run(await r.countOpenRequirementConflicts(ORG, TENDER))).toMatchObject({ status: "rojo" });

    const resolved = await r.resolveRequirementConflict(ORG, TENDER, conflicts[0]!.id, { actorId: "u1", notes: "Prevalece el acta de junta." });
    expect(resolved).toMatchObject({ status: "resuelto", resolvedBy: "u1", resolutionNotes: "Prevalece el acta de junta." });
    expect(run(await r.countOpenRequirementConflicts(ORG, TENDER))).toMatchObject({ status: "verde" });
    // desbloquea los requisitos y no reabre el conflicto resuelto al re-detectar lo mismo
    expect((await r.listRequirementMatrix(ORG, TENDER, { includeRetired: false })).items.some((i) => i.status === "bloqueado")).toBe(false);
    await r.syncRequirementConflicts(ORG, TENDER, detected);
    expect(await r.countOpenRequirementConflicts(ORG, TENDER)).toBe(0);
    expect(await r.resolveRequirementConflict(ORG, TENDER, conflicts[0]!.id, { actorId: "u1", notes: "otra vez" })).toBeNull();
  });

  it("un conflicto abierto que la extraccion ya no detecta se cierra solo, sin resolved_by", async () => {
    const { r, detected } = await setup();
    await r.syncRequirementConflicts(ORG, TENDER, detected);
    const after = await r.syncRequirementConflicts(ORG, TENDER, []);
    expect(after.conflicts[0]).toMatchObject({ status: "resuelto", resolvedBy: null });
    expect(await r.countOpenRequirementConflicts(ORG, TENDER)).toBe(0);
  });

  it("base sin la 037: no hay conflictos persistidos ni bloqueo", async () => {
    const r = repo();
    r.boveda037 = false;
    expect(await r.syncRequirementConflicts(ORG, TENDER, [])).toEqual({ disponible: false, conflicts: [] });
    expect(await r.countOpenRequirementConflicts(ORG, TENDER)).toBe(0);
  });
});

describe("editor humano de secciones y comentarios (L-P3-07)", () => {
  async function withApprovedSection() {
    const r = repo();
    const proposal = await r.getOrCreateProposal(ORG, TENDER, "writer-1", "Propuesta");
    r.seedProposalSection(proposal.id, { documentId: "doc-1", sectionKey: "technical:legal", label: "Cumplimiento legal", filename: "legal.txt", version: 1, content: "Texto original." });
    const approval = await r.approve(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:technical:legal", actorId: "owner-1", actorRole: "owner", inputsHash: sealInputs(INPUTS) });
    return { r, proposal, approval };
  }

  it("AE-02: el mismo texto no invalida la aprobacion; un texto distinto la invalida y sube la version", async () => {
    const { r, proposal } = await withApprovedSection();
    const same = await r.editProposalSection(ORG, proposal.id, "technical:legal", { content: "Texto original.", actorId: "writer-1" });
    expect(same).toMatchObject({ changed: false, invalidated: null });
    expect(await r.activeApprovalsCovering(ORG, proposal.id, "seccion:technical:legal")).toHaveLength(1);

    const changed = await r.editProposalSection(ORG, proposal.id, "technical:legal", { content: "Texto corregido por una persona.", actorId: "writer-1" });
    expect(changed).toMatchObject({ changed: true });
    expect(changed!.section.version).toBe(2);
    expect(changed!.invalidated!.invalidatedApprovalIds).toHaveLength(1);
    expect(await r.activeApprovalsCovering(ORG, proposal.id, "seccion:technical:legal")).toHaveLength(0);
  });

  it("editar tambien invalida la aprobacion vigente del expediente", async () => {
    const { r, proposal } = await withApprovedSection();
    await r.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "owner-2", actorRole: "owner", inputsHash: sealInputs(INPUTS) });
    expect(await r.activeApprovalsCovering(ORG, proposal.id, "expediente")).toHaveLength(1);
    await r.editProposalSection(ORG, proposal.id, "technical:legal", { content: "Otro texto.", actorId: "writer-1" });
    expect(await r.activeApprovalsCovering(ORG, proposal.id, "expediente")).toHaveLength(0);
  });

  it("AE-11: quien edita la seccion no puede aprobarla ni aprobar el expediente", async () => {
    const { r, proposal } = await withApprovedSection();
    await r.editProposalSection(ORG, proposal.id, "technical:legal", { content: "Texto del analista.", actorId: "analyst-1" });
    await expect(r.approve(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:technical:legal", actorId: "analyst-1", actorRole: "analyst", inputsHash: sealInputs(INPUTS) })).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(r.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "analyst-1", actorRole: "analyst", inputsHash: sealInputs(INPUTS) })).rejects.toBeInstanceOf(ApprovalRejectedError);
    // otra persona si puede
    await expect(r.approve(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:technical:legal", actorId: "owner-3", actorRole: "owner", inputsHash: sealInputs(INPUTS) })).resolves.toMatchObject({ status: "vigente" });
  });

  it("una seccion inexistente devuelve null y los datos de otra organizacion no se alcanzan", async () => {
    const { r, proposal } = await withApprovedSection();
    expect(await r.editProposalSection(ORG, proposal.id, "no-existe", { content: "x", actorId: "u" })).toBeNull();
    await expect(r.editProposalSection("otra-org", proposal.id, "technical:legal", { content: "x", actorId: "u" })).rejects.toThrow();
  });

  it("los comentarios son solo de adicion, quedan por alcance y la solicitud de revision impide autoaprobarse", async () => {
    const { r, proposal } = await withApprovedSection();
    await r.addProposalComment(ORG, proposal.id, { scope: "seccion", scopeRef: "seccion:technical:legal", kind: "comentario", body: "Falta el anexo 3.", authorId: "w1", authorRole: "writer" });
    await r.addProposalComment(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", kind: "solicitud_revision", body: "Listo para revision.", authorId: "owner-9", authorRole: "owner" });
    const { comments, disponible } = await r.listProposalComments(ORG, proposal.id);
    expect(disponible).toBe(true);
    expect(comments.map((c) => c.kind)).toEqual(["comentario", "solicitud_revision"]);
    await expect(r.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "owner-9", actorRole: "owner", inputsHash: sealInputs(INPUTS) })).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(r.listProposalComments("otra-org", proposal.id)).rejects.toThrow();
  });

  it("base sin la 037: comentar es 'no disponible' y listar da vacio honesto", async () => {
    const { r, proposal } = await withApprovedSection();
    r.boveda037 = false;
    await expect(r.addProposalComment(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", kind: "comentario", body: "x", authorId: "w", authorRole: "writer" })).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
    expect(await r.listProposalComments(ORG, proposal.id)).toEqual({ disponible: false, comments: [] });
  });
});

describe("boveda de documentos (L-P3-05)", () => {
  const upload = (over: Record<string, unknown> = {}) => ({
    documentType: "bases" as const,
    title: "Bases",
    filename: "bases.pdf",
    mimeType: "application/pdf",
    buffer: new TextEncoder().encode("%PDF-1.4 contenido"),
    extractionStatus: "extracted" as const,
    extractionDetail: null,
    pageCount: 2,
    pages: [{ page: 1, text: "Pagina uno" }, { page: 2, text: "Pagina dos" }],
    actorId: "u1",
    replacesDocumentId: null,
    ...over,
  });

  it("guarda con sha256, tamano y paginas; una version nueva comparte linaje y deja la anterior como no vigente", async () => {
    const r = repo();
    const v1 = await r.createTenderDocument(ORG, TENDER, upload());
    expect(v1).toMatchObject({ version: 1, latest: true, extractionStatus: "extracted", sizeBytes: 18 });
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
    const v2 = await r.createTenderDocument(ORG, TENDER, upload({ replacesDocumentId: v1.id }));
    expect(v2).toMatchObject({ version: 2, lineageId: v1.lineageId });
    const { documents } = await r.listTenderDocuments(ORG, TENDER);
    expect(documents.find((d) => d.id === v1.id)!.latest).toBe(false);
    expect(documents.find((d) => d.id === v2.id)!.latest).toBe(true);
  });

  it("el texto por pagina queda disponible para re-extraer y citar; otra organizacion no lo ve", async () => {
    const r = repo();
    const doc = await r.createTenderDocument(ORG, TENDER, upload());
    expect((await r.getTenderDocument(ORG, TENDER, doc.id))!.pages).toEqual([{ page: 1, text: "Pagina uno" }, { page: 2, text: "Pagina dos" }]);
    expect(await r.getTenderDocument("otra-org", TENDER, doc.id)).toBeNull();
    expect((await r.listTenderDocuments("otra-org", TENDER)).documents).toEqual([]);
  });

  it("un PDF sin texto se guarda como requires_ocr sin inventar paginas", async () => {
    const r = repo();
    const doc = await r.createTenderDocument(ORG, TENDER, upload({ extractionStatus: "requires_ocr", extractionDetail: "PDF sin capa de texto", pages: null, pageCount: 3 }));
    expect(doc).toMatchObject({ extractionStatus: "requires_ocr", extractionDetail: "PDF sin capa de texto" });
    expect((await r.getTenderDocument(ORG, TENDER, doc.id))!.pages).toBeNull();
  });

  it("base sin la 037: no se puede subir (503 honesto) y el listado dice que no esta disponible", async () => {
    const r = repo();
    r.boveda037 = false;
    await expect(r.createTenderDocument(ORG, TENDER, upload())).rejects.toBeInstanceOf(BovedaRevisionNoDisponibleError);
    expect(await r.listTenderDocuments(ORG, TENDER)).toEqual({ disponible: false, documents: [] });
  });
});
