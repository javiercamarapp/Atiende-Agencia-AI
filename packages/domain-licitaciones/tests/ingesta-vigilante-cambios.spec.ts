// paridad3 L-P3-08 -- vigilante de cambios en la ingesta AUTOMATICA. Cubre: el plan puro (linea base, idempotencia, cambio real,
// documentos que aparecen por primera vez), el repositorio en memoria (version, cascada, aviso, idempotencia, aislamiento por
// organizacion) y el repositorio de Postgres contra la base SIN la migracion 039 (AbortAwareFakeSession: la ingesta NO se pierde).
import { describe, expect, it } from "vitest";
import { InMemoryLicitacionesRepository } from "../src/in-memory-repository.ts";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { sealInputs } from "../src/sealed-inputs.ts";
import { planIngestTenderVersion } from "../src/tender-ingest-versioning.ts";
import { canonicalDocumentLine } from "../src/tender-version-registry.ts";
import type { PersistedTenderVersion } from "../src/tender-version-registry.ts";
import type { TenderSourceDocument, TenderSourceIngestCandidate } from "../src/connectors/types.ts";
import { mapOcdsDocuments, mapOcdsReleaseToCandidate } from "../src/connectors/ocds/map-ocds-release.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "org-1";
const OTRA_ORG = "org-2";

const candidato = (over: Partial<TenderSourceIngestCandidate> = {}): TenderSourceIngestCandidate => ({
  externalId: "ocds-abc-1",
  title: "Servicio de limpieza",
  submissionDeadline: "2026-12-15T18:00:00-06:00",
  contractingBody: "Secretaria de prueba",
  cpvCodes: ["90910000"],
  budgetAmount: 100_000,
  currency: "MXN",
  state: "Jalisco",
  procedureTypeRaw: "licitacion_publica",
  ...over,
});

const DOC_A: TenderSourceDocument = { url: "https://fuente.gob.mx/bases-a.pdf", title: "Bases", documentType: "biddingDocuments", datePublished: "2026-11-01T10:00:00Z" };
const DOC_B: TenderSourceDocument = { url: "https://fuente.gob.mx/anexo-b.pdf", title: "Anexo", documentType: "technicalSpecifications", datePublished: null };

const tenderBase = { title: "T", submissionDeadline: "2026-12-15T18:00:00-06:00", contractingBody: "E", cpvCodes: ["1"], budgetAmount: 10, currency: "MXN", state: null, procedureTypeRaw: null };

function comoVersion(plan: ReturnType<typeof planIngestTenderVersion>): PersistedTenderVersion {
  return { version: plan.nextVersion, hash: plan.hash, snapshot: plan.snapshot, diff: plan.diff, createdAt: "2026-10-01T00:00:00Z" };
}

describe("planIngestTenderVersion (funcion pura)", () => {
  it("primera captura: linea base silenciosa (no avisa, no invalida)", () => {
    const plan = planIngestTenderVersion(null, tenderBase, undefined);
    expect(plan.action).toBe("baseline");
    expect(plan.nextVersion).toBe(1);
    expect(plan.cascade).toEqual([]);
    expect(plan.changedFieldNames).toEqual([]);
  });

  it("mismo contenido otra vez: nada que hacer (idempotente, REQ-154)", () => {
    const v1 = comoVersion(planIngestTenderVersion(null, tenderBase, [DOC_A]));
    expect(planIngestTenderVersion(v1, tenderBase, [DOC_A]).action).toBe("none");
    // el orden de los documentos que publica la fuente no cambia el hash
    const v2 = comoVersion(planIngestTenderVersion(null, tenderBase, [DOC_A, DOC_B]));
    expect(planIngestTenderVersion(v2, tenderBase, [DOC_B, DOC_A]).action).toBe("none");
  });

  it("cambia el plazo o el monto: cambio real con cascada sobre el expediente", () => {
    const v1 = comoVersion(planIngestTenderVersion(null, tenderBase, undefined));
    const plan = planIngestTenderVersion(v1, { ...tenderBase, submissionDeadline: "2026-12-20T18:00:00-06:00", budgetAmount: 20 }, undefined);
    expect(plan.action).toBe("changed");
    expect(plan.nextVersion).toBe(2);
    expect(plan.changedFieldNames).toEqual(["budgetAmount", "submissionDeadline"]);
    expect(plan.cascade).toEqual([{ scope: "expediente", scopeRef: "expediente", reason: "tender_version_changed:v2:budgetAmount,submissionDeadline" }]);
  });

  it("los documentos que aparecen por primera vez en una convocatoria ya versionada son linea base, no un cambio de la fuente", () => {
    const sinDocumentos = comoVersion(planIngestTenderVersion(null, tenderBase, undefined));
    const plan = planIngestTenderVersion(sinDocumentos, tenderBase, [DOC_A]);
    expect(plan.action).toBe("baseline");
    expect(plan.cascade).toEqual([]);
    // y a partir de ahi un documento nuevo o retirado SI es un cambio de bases
    const conDocumentos = comoVersion(plan);
    expect(planIngestTenderVersion(conDocumentos, tenderBase, [DOC_A, DOC_B])).toMatchObject({ action: "changed", changedFieldNames: ["documents"] });
    expect(planIngestTenderVersion(conDocumentos, tenderBase, undefined)).toMatchObject({ action: "changed", changedFieldNames: ["documents"] });
  });

  it("hereda los requisitos de la ultima version (la ingesta no los lee: nunca inventa un requisito eliminado)", () => {
    const requisito = { key: "legal:text:x", requirementKind: "legal" as const, text: "x", obligatoriedad: "obligatorio" as const, topicKey: null, requiredEvidence: [], deadline: null };
    const base = comoVersion(planIngestTenderVersion(null, tenderBase, undefined));
    const conRequisito: PersistedTenderVersion = { ...base, snapshot: { ...base.snapshot, requirements: [requisito] } };
    const plan = planIngestTenderVersion(conRequisito, { ...tenderBase, title: "Nuevo titulo" }, undefined);
    expect(plan.snapshot.requirements).toEqual([requisito]);
    expect(plan.diff.requirements.every((r) => r.status === "sin_cambio")).toBe(true);
  });

  it("canonicalDocumentLine neutraliza el separador dentro de los textos", () => {
    expect(canonicalDocumentLine({ documentType: "a|b", title: null, url: "https://x/y", datePublished: null })).toBe("a/b||https://x/y|");
  });
});

describe("mapeo OCDS de tender.documents[]", () => {
  it("solo https absolutos sin credenciales, deduplicados y con tope; el resto se descarta sin fabricar nada", () => {
    const docs = mapOcdsDocuments({
      documents: [
        { url: "https://fuente.gob.mx/a.pdf", title: " Bases ", documentType: "biddingDocuments", datePublished: "2026-11-01T10:00:00Z" },
        { url: "https://fuente.gob.mx/a.pdf", title: "duplicado" },
        { url: "http://fuente.gob.mx/inseguro.pdf" },
        { url: "https://user:pass@fuente.gob.mx/c.pdf" },
        { url: "/relativo.pdf" },
        { url: "file:///etc/passwd" },
        { url: "javascript:alert(1)" },
        { url: "https://fuente.gob.mx/b.pdf", datePublished: "2026-11-01" },
        { title: "sin url" },
      ],
    });
    expect(docs).toEqual([
      { url: "https://fuente.gob.mx/a.pdf", title: "Bases", documentType: "biddingDocuments", datePublished: "2026-11-01T10:00:00Z" },
      { url: "https://fuente.gob.mx/b.pdf", title: null, documentType: null, datePublished: null },
    ]);
    const muchos = mapOcdsDocuments({ documents: Array.from({ length: 80 }, (_, i) => ({ url: `https://fuente.gob.mx/${i}.pdf` })) });
    expect(muchos).toHaveLength(50);
  });

  it("un titulo o tipo de documento que no es texto (JSON crudo) se trata como ausente y no lanza", () => {
    const docs = mapOcdsDocuments({ documents: [{ url: "https://fuente.gob.mx/x.pdf", title: 42, documentType: { a: 1 } }] } as unknown as Parameters<typeof mapOcdsDocuments>[0]);
    expect(docs).toEqual([{ url: "https://fuente.gob.mx/x.pdf", title: null, documentType: null, datePublished: null }]);
  });

  it("el candidato lleva `documents` solo cuando la fuente los publica", () => {
    const con = mapOcdsReleaseToCandidate({ ocid: "ocds-1", tender: { title: "T", documents: [{ url: "https://fuente.gob.mx/a.pdf" }] } }, { fixedState: null });
    const sin = mapOcdsReleaseToCandidate({ ocid: "ocds-2", tender: { title: "T" } }, { fixedState: null });
    expect("candidate" in con && con.candidate.documents).toHaveLength(1);
    expect("candidate" in sin && "documents" in sin.candidate).toBe(false);
  });
});

describe("InMemoryLicitacionesRepository.ingestTendersFromSource -- vigilante de cambios", () => {
  it("la primera ingesta guarda la linea base: version 1, sin aviso de cambio y sin cambios de bases reportados", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const r = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()]);
    expect(r.created).toBe(1);
    expect(r.createdTenderIds).toEqual([r.tenders[0]!.id]);
    expect(r.basesModificadas).toEqual([]);
    expect(await repo.listTenderVersions(ORG, r.tenders[0]!.id)).toHaveLength(1);
    expect(await repo.listTenderChangeNotifications(ORG, r.tenders[0]!.id)).toHaveLength(0);
  });

  it("si la fuente cambia el plazo: version 2, cambio reportado, notificacion de cambio y aprobacion del expediente invalidada", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const primera = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()]);
    const tenderId = primera.tenders[0]!.id;
    const proposal = await repo.getOrCreateProposal(ORG, tenderId, "user-1", "Propuesta");
    const sellado = sealInputs({ tenderVersionHash: "x", companyProfileHash: "y", companyDocuments: [], rates: [], templates: [] });
    await repo.approve(ORG, proposal.id, { scope: "expediente", scopeRef: "expediente", actorId: "owner-1", actorRole: "owner", inputsHash: sellado });

    const segunda = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato({ submissionDeadline: "2026-12-30T18:00:00-06:00" })]);

    expect(segunda.created).toBe(0);
    expect(segunda.createdTenderIds).toEqual([]);
    expect(segunda.basesModificadas).toEqual([{ tenderId, tenderTitle: "Servicio de limpieza", version: 2, changedFieldNames: ["submissionDeadline"], invalidatedApprovals: 1, invalidatedApproverIds: ["owner-1"] }]);
    expect(await repo.activeApprovalsCovering(ORG, proposal.id, "expediente")).toHaveLength(0);
    const [aviso] = await repo.listTenderChangeNotifications(ORG, tenderId);
    expect(aviso).toMatchObject({ reason: "convocatoria_actualizada:v2", changedFieldNames: ["submissionDeadline"] });
  });

  it("reprocesar la MISMA version es idempotente: sin version, sin cascada, sin cambio reportado", async () => {
    const repo = new InMemoryLicitacionesRepository();
    const c = candidato({ documents: [DOC_A] });
    await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [c]);
    const otra = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [c]);
    expect(otra.basesModificadas).toEqual([]);
    expect(await repo.listTenderVersions(ORG, otra.tenders[0]!.id)).toHaveLength(1);
    expect(await repo.listTenderChangeNotifications(ORG, otra.tenders[0]!.id)).toHaveLength(0);
  });

  it("un documento nuevo en las bases es un cambio de bases (version 2, campo `documents`)", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato({ documents: [DOC_A] })]);
    const r = await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato({ documents: [DOC_A, DOC_B] })]);
    expect(r.basesModificadas).toHaveLength(1);
    expect(r.basesModificadas![0]).toMatchObject({ version: 2, changedFieldNames: ["documents"] });
  });

  it("el vigilante no cruza organizaciones: el mismo externalId en otra organizacion es una convocatoria distinta con su propia linea base", async () => {
    const repo = new InMemoryLicitacionesRepository();
    await repo.ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()]);
    const r = await repo.ingestTendersFromSource(OTRA_ORG, "compras_mx_historico", [candidato({ submissionDeadline: "2027-01-01T18:00:00-06:00" })]);
    expect(r.created).toBe(1);
    expect(r.basesModificadas).toEqual([]);
  });
});

describe("PostgresLicitacionesRepository.ingestTendersFromSource -- base SIN la migracion 039", () => {
  const filaTender = {
    out_id: "00000000-0000-0000-0000-0000000000c1",
    out_organization_id: ORG,
    out_title: "Servicio de limpieza",
    out_submission_deadline: "2026-12-15 18:00:00-06",
    out_updated_at: "2026-10-01 00:00:00+00",
    out_source: "compras_mx_historico",
    out_external_id: "ocds-abc-1",
    out_contracting_body: null,
    out_cpv_codes: [],
    out_budget_amount: null,
    out_currency: "MXN",
    out_state: null,
    out_procedure_type_raw: null,
    out_status: "discovered",
    out_inserted: true,
  };
  const funcionInexistente = (nombre: string) => Object.assign(new Error(`function licitaciones.${nombre}(uuid, uuid) does not exist`), { code: "42883" });

  it("42883 en el vigilante: SAVEPOINT + rollback; la convocatoria se conserva, el resultado lo declara y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_ingest_tender/, respond: () => [filaTender] },
      { match: /system_latest_tender_version/, respond: () => funcionInexistente("system_latest_tender_version") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()]);
    expect(r.created).toBe(1);
    expect(r.tenders).toHaveLength(1);
    expect(r.basesModificadas).toEqual([]);
    expect(r.vigilanteNoDisponible).toMatch(/039_licitaciones_autopiloto/);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("tras el primer fallo de migracion el resto del lote no insiste con el vigilante (una sola llamada, todas las convocatorias se guardan)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_ingest_tender/, respond: () => [filaTender] },
      { match: /system_latest_tender_version/, respond: () => funcionInexistente("system_latest_tender_version") },
    ]);
    const r = await new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "compras_mx_historico", [candidato(), candidato({ externalId: "ocds-abc-2" }), candidato({ externalId: "ocds-abc-3" })]);
    expect(r.created).toBe(3);
    expect(session.calls.filter((c) => /system_latest_tender_version/.test(c))).toHaveLength(1);
  });

  it("un error de Postgres que NO es de migracion pendiente se propaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_ingest_tender/, respond: () => [filaTender] },
      { match: /system_latest_tender_version/, respond: () => Object.assign(new Error("deadlock detected"), { code: "40P01" }) },
    ]);
    await expect(new PostgresLicitacionesRepository(session).ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()])).rejects.toMatchObject({ code: "40P01" });
  });

  it("base migrada: la primera captura llama a la funcion de escritura como linea base silenciosa (notify=false, sin cascada)", async () => {
    const llamadas: unknown[][] = [];
    const base = new AbortAwareFakeSession([
      { match: /system_ingest_tender/, respond: () => [filaTender] },
      { match: /system_latest_tender_version/, respond: () => [] },
      { match: /system_record_ingested_tender_version/, respond: () => [{ out_version: 1, out_created: true, out_notification_id: null, out_invalidated_approval_ids: [], out_invalidated_approver_ids: [] }] },
    ]);
    const original = base.query.bind(base);
    base.query = (async (sql: string, params?: unknown[]) => {
      if (/system_record_ingested_tender_version/.test(sql)) llamadas.push(params ?? []);
      return original(sql, params);
    }) as typeof base.query;
    const r = await new PostgresLicitacionesRepository(base).ingestTendersFromSource(ORG, "compras_mx_historico", [candidato()]);
    expect(r.vigilanteNoDisponible).toBeUndefined();
    expect(r.basesModificadas).toEqual([]);
    expect(llamadas).toHaveLength(1);
    const [org, tender, hash, , , notify, reason, changed, , roles, cascade] = llamadas[0]!;
    expect([org, tender, notify, reason, changed, cascade]).toEqual([ORG, filaTender.out_id, false, "convocatoria_nueva", [], "[]"]);
    expect(String(hash)).toHaveLength(64);
    expect(roles).toContain("owner");
  });
});
