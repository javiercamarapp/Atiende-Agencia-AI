// Puerto de acceso a datos de domain-licitaciones — mismo patrón dual de
// adaptador que domain-hoteles/domain-restaurantes (ver diseño Fase 1 §3.2).
// Ningún flujo de apps/api toca SQL directamente — todo pasa por aquí.
import type {
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  PackageManifestRecord,
  ExpedienteApprovalRecord,
  SubmissionRecord,
  RequiredAnnexItem,
} from "./types.ts";

export interface IdempotencyParams {
  readonly organizationId: string;
  readonly scope: string;
  readonly key: string;
  readonly body: unknown;
}
export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface LicitacionesRepository {
  // ---- Convocatoria / expediente (transversal) ----
  findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null>;
  getOrCreateProposal(organizationId: string, tenderId: string, userId: string, title: string): Promise<ProposalRecord>;
  findProposal(organizationId: string, tenderId: string): Promise<ProposalRecord | null>;

  // ---- Flujo 1: checklist de integridad ----
  listComplianceItems(organizationId: string, proposalId: string): Promise<readonly ComplianceItemRecord[]>;
  replaceComplianceItems(organizationId: string, tenderId: string, proposalId: string, items: readonly ComplianceItemRecord[]): Promise<void>;
  listRequiredAnnexes(organizationId: string, tenderId: string): Promise<readonly RequiredAnnexItem[]>;
  listCompanyDocuments(organizationId: string, asOfIso: string): Promise<readonly CompanyDocumentRecord[]>;

  // ---- Flujo 2: propuesta económica ----
  listApprovedRates(organizationId: string, asOfIso: string): Promise<readonly ApprovedRateRecord[]>;
  saveEconomicGeneration(
    organizationId: string,
    proposalId: string,
    input: {
      economicTotals: unknown | null;
      generationReportPatch: unknown;
      correlationId: string | null;
      cartaSection?: { content: string; sources: unknown };
      anexoSection?: { content: string; sources: unknown };
    },
  ): Promise<ProposalRecord>;

  // ---- Flujo 3: ensamblado / descarga / declaración ----
  loadProposalSectionsAsDocuments(organizationId: string, proposalId: string): Promise<readonly { documentId: string; label: string; filename: string; version: number; content?: string }[]>;
  /** Wrapper sobre sealed-inputs.ts::sealInputs — `raw` es el `ExpedienteInputs` construido con los insumos REALMENTE usados por esta propuesta. */
  computeCurrentInputsHash(organizationId: string, tenderId: string, proposalId: string): Promise<{ hash: string; raw: unknown }>;
  findCurrentExpedienteApproval(organizationId: string, proposalId: string): Promise<ExpedienteApprovalRecord | null>;
  approveExpediente(organizationId: string, proposalId: string, approverId: string, approverRole: string, inputsHash: string): Promise<ExpedienteApprovalRecord>;
  saveManifest(
    organizationId: string,
    proposalId: string,
    input: { status: "draft" | "ready"; manifest: unknown; checklistSnapshot: unknown; storageRef: string; inputsHash: string; correlationId: string | null; generatedBy: string },
  ): Promise<{ id: string; generatedAt: string }>;
  findLatestManifest(organizationId: string, proposalId: string): Promise<PackageManifestRecord | null>;
  /** Escribe los bytes del ZIP a donde el adaptador decida (disco local en Fase 1, ver storage.ts) y devuelve el `storageRef` opaco a persistir en `saveManifest`. */
  writeManifestZip(organizationId: string, proposalId: string, zip: Uint8Array): Promise<string>;
  readManifestZip(storageRef: string): Promise<Uint8Array>;
  /** Guarda el acuse de presentación (subido por el usuario) por el mismo mecanismo de almacenamiento que el ZIP del expediente — dedupe natural por hash de contenido. */
  storeAcknowledgement(organizationId: string, buffer: Uint8Array): Promise<{ storageRef: string; sha256: string }>;

  findSubmission(organizationId: string, proposalId: string): Promise<SubmissionRecord | null>;
  declareSubmission(
    organizationId: string,
    proposalId: string,
    input: { userId: string; submittedAt: string; acknowledgementStorageRef: string | null; acknowledgementFileHash: string | null; notes: string | null },
  ): Promise<SubmissionRecord>;

  // ---- Idempotencia (transversal) ----
  withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>>;
}

export type {
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  PackageManifestRecord,
  ExpedienteApprovalRecord,
  SubmissionRecord,
  RequiredAnnexItem,
} from "./types.ts";
