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
  SubmissionRecord,
  RequiredAnnexItem,
  MatchingProfileRecord,
  GoNoGoDecisionRecord,
} from "./types.ts";
import type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import type { PersistedProposalVersion } from "./proposal-version-registry.ts";
import type { LicitacionesRole } from "./roles.ts";
import type { EligibilityStatus } from "./matching-engine.ts";

// ---- Fase 2 pieza 3: RequirementMatrix / TechnicalProposalBuilder ----
// Formas de registro deliberadamente con uniones de string LITERALES (no
// importadas de requirement-matrix.ts) -- mismo patrón que el resto de este
// archivo/types.ts (p. ej. `ComplianceItemRecord.result`), para no crear una
// dependencia circular repository.ts -> requirement-matrix.ts -> types.ts.

export interface RequirementItemRecord {
  readonly id: string;
  readonly documentId: string | null;
  readonly text: string;
  readonly requirementKind: "tecnico" | "economico" | "legal" | "administrativo" | "anexo";
  readonly obligatoriedad: "obligatorio" | "opcional" | "condicional";
  readonly topicKey: string | null;
  readonly requiredEvidence: readonly string[];
  readonly extractedBy: "rule" | "llm";
  readonly page: number | null;
  readonly clause: string | null;
  readonly responsibleRole: string;
  readonly deadline: string | null;
  readonly status: "pendiente" | "en_progreso" | "cumplido" | "bloqueado" | "no_evaluable";
  readonly confidence: number | null;
}

export interface RequirementFulfillmentMappingRecord {
  readonly id: string;
  readonly topicKey: string;
  readonly kind: "capability" | "experience" | "document" | "signer";
  readonly refKey: string;
  readonly statementTemplate: string;
}

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

// ---- Fase 3: matching/scoring y go/no-go ----

export interface TenderUpsertInput {
  readonly title: string;
  readonly submissionDeadline: string | null;
  /** Clave natural de dedupe: presente -> upsert por (organizationId, source='manual', externalId); ausente -> siempre crea (el llamador es responsable de no duplicar a mano, ver diseño §6). */
  readonly externalId: string | null;
  readonly contractingBody: string | null;
  readonly cpvCodes: readonly string[];
  readonly budgetAmount: number | null;
  readonly currency: string;
  readonly state: string | null;
  readonly procedureTypeRaw: string | null;
  /** Tomado SIEMPRE de la sesión autenticada (`c.get("userId")`), nunca del cuerpo del request. */
  readonly actorId: string;
}

export interface TenderUpsertResult {
  readonly tender: TenderRecord;
  readonly created: boolean;
  /** `true` solo si esta operación fue una ACTUALIZACIÓN (created=false) y `submissionDeadline` cambió respecto del valor previo -- dispara `recordChange` sobre la propuesta abierta de esta convocatoria, si existe. */
  readonly submissionDeadlineChanged: boolean;
}

export interface MatchingProfileUpsertInput {
  readonly keywords: readonly string[];
  readonly excludedKeywords: readonly string[];
  readonly classifierCodes: readonly string[];
  readonly entities: readonly string[];
  readonly states: readonly string[];
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
  readonly actorId: string;
}

export interface GoNoGoDecisionCreateInput {
  readonly decision: "go" | "no_go";
  readonly reasons: readonly string[];
  readonly matchScore: number;
  readonly matchEligibilityStatus: EligibilityStatus;
  readonly matchInputsHash: string;
  readonly actorId: string;
  readonly actorRole: LicitacionesRole;
}

export interface LicitacionesRepository {
  // ---- Convocatoria / expediente (transversal) ----
  findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null>;
  getOrCreateProposal(organizationId: string, tenderId: string, userId: string, title: string): Promise<ProposalRecord>;
  findProposal(organizationId: string, tenderId: string): Promise<ProposalRecord | null>;

  // ---- Fase 3 pieza 1: alta manual de convocatoria (§6) ----
  /** Lista TODAS las convocatorias de la organización (para `GET .../tenders/matching`, la vista de lista) -- sin paginar en esta fase (mismo criterio de simplicidad que el resto de listas de Fase 1/2). */
  listTenders(organizationId: string): Promise<readonly TenderRecord[]>;
  /**
   * Crea o actualiza (upsert por `externalId`, ver `TenderUpsertInput`) una
   * convocatoria manual. SIEMPRE fija `source='manual'` server-side (nunca
   * acepta el valor del cliente) y registra la auditoría
   * (`licitaciones.tender_audit_log`, acción
   * `tender.manual_upsert.created|updated`) en la MISMA operación -- nunca
   * depende de que la ruta se acuerde de auditar por separado (mismo
   * criterio que AE-11/`recordSectionAuthor`).
   */
  upsertTenderManual(organizationId: string, input: TenderUpsertInput): Promise<TenderUpsertResult>;

  // ---- Fase 3 pieza 2: perfil de matching de la organización (§5) ----
  findMatchingProfile(organizationId: string): Promise<MatchingProfileRecord | null>;
  upsertMatchingProfile(organizationId: string, input: MatchingProfileUpsertInput): Promise<MatchingProfileRecord>;

  // ---- Fase 3 pieza 3: decisiones go/no-go (§7) ----
  /**
   * Valida (vía `buildGoNoGoDecision`, go-no-go.ts -- lanza
   * `GoNoGoRejectedError` si el rol o los motivos no pasan la regla, sin
   * tocar ninguna fila) y persiste la decisión, y en la MISMA operación
   * actualiza `licitaciones.tender.status` al valor de la decisión (único
   * camino que saca una convocatoria de `discovered`/`in_review`).
   */
  createGoNoGoDecision(organizationId: string, tenderId: string, input: GoNoGoDecisionCreateInput): Promise<GoNoGoDecisionRecord>;
  /** Historial COMPLETO de decisiones (no solo la última), más recientes primero -- permite reabrir un `no_go` con un `go` posterior sin perder el rastro. */
  listGoNoGoDecisions(organizationId: string, tenderId: string): Promise<readonly GoNoGoDecisionRecord[]>;

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
      actorId: string;
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

  // ---- Fase 2 pieza 1: máquina de aprobaciones granular (AE-02/AE-11) ----
  /**
   * Aprueba `input.scope`/`input.scopeRef` para `proposalId`: hidrata una
   * `ApprovalWorkflow` en memoria con los autores de sección ya registrados
   * (`licitaciones.section_author`, AE-11) y ejerce la misma máquina pura de
   * dominio que `packages/domain-licitaciones/src/approval-workflow.ts`
   * expone para pruebas directas — lanza `ApprovalRejectedError` si la regla
   * rechaza la operación (rol no autorizado, AE-02, o autoaprobación AE-11).
   * Si la validación pasa, invalida (marca "invalidada") cualquier
   * aprobación previa "vigente" de EXACTAMENTE el mismo `scope`/`scopeRef`
   * antes de insertar la nueva — nunca coexisten dos aprobaciones vigentes
   * para el mismo alcance exacto.
   */
  approve(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; actorId: string; actorRole: LicitacionesRole; inputsHash: HashedInputs }): Promise<Approval>;
  /** Invalida toda aprobación vigente cuyo alcance cubra `input.scopeRef` (la aprobación exacta, o "expediente" cubriendo cualquier sección) y deja un registro de auditoría en `licitaciones.approval_change`. */
  recordChange(organizationId: string, proposalId: string, input: { scope: ApprovalScope; scopeRef: string; reason: string }): Promise<ChangeDetected>;
  /** Aprobaciones vigentes que cubren `scopeRef` (aprobación exacta, o "expediente" cubriendo cualquier sección). */
  activeApprovalsCovering(organizationId: string, proposalId: string, scopeRef: string): Promise<readonly Approval[]>;
  /**
   * Combina, en un solo choque de estado: (a) registra una nueva
   * `licitaciones.proposal_version` si `sealed.hash` difiere de la última
   * versión persistida (Fase 2 pieza 2), y (b) si la aprobación vigente de
   * alcance "expediente" ya no coincide con `sealed.hash`, la invalida vía
   * `recordChange` con un motivo LEGIBLE que nombra los insumos que
   * cambiaron (`ProposalVersionRegistry.diff` contra la versión anterior),
   * en vez del mensaje opaco `hash_insumos_divergente:...` de Fase 1. Debe
   * llamarse antes de derivar el estado de aprobación en cualquier punto que
   * lo necesite (mismo choke point que `buildAssembleInput`, AE-14).
   */
  syncExpedienteApprovalWithCurrentHash(organizationId: string, proposalId: string, sealed: HashedInputs, raw: ExpedienteInputs): Promise<ChangeDetected | null>;
  /** Última `licitaciones.proposal_version` registrada para `proposalId`, o `null` si nunca se registró ninguna (propuesta recién creada). Solo lectura/inspección — la escritura ocurre dentro de `syncExpedienteApprovalWithCurrentHash`. */
  latestProposalVersion(organizationId: string, proposalId: string): Promise<PersistedProposalVersion | null>;

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

  // ---- Fase 2 pieza 3: RequirementMatrix / TechnicalProposalBuilder ----
  /** Sustituye TODOS los `requirement_item` de `tenderId` por `items` (mismo criterio de reemplazo completo que `replaceComplianceItems` -- nunca acumula historial de corridas de extracción). */
  replaceRequirementItems(organizationId: string, tenderId: string, items: readonly RequirementItemRecord[]): Promise<void>;
  listRequirementItems(organizationId: string, tenderId: string): Promise<readonly RequirementItemRecord[]>;
  listFulfillmentMappings(organizationId: string): Promise<readonly RequirementFulfillmentMappingRecord[]>;
  /** Configura (o reemplaza) el mapeo requisito->dato-de-empresa para un `topicKey` -- editable por DECISION_ROLES (decidir de qué dato se redacta un requisito es una decisión editorial/de riesgo, no redacción). */
  upsertFulfillmentMapping(organizationId: string, input: { topicKey: string; kind: RequirementFulfillmentMappingRecord["kind"]; refKey: string; statementTemplate: string }): Promise<RequirementFulfillmentMappingRecord>;
  /**
   * Persiste las secciones de la propuesta TÉCNICA (una por cada
   * `SECTION_KEY_BY_REQUIREMENT_TYPE` presente, ver requirement-matrix.ts) en
   * `licitaciones.proposal_section` -- mismo mecanismo que
   * `saveEconomicGeneration` (dispara `section_author`/AE-11 vía el `actorId`
   * de la sesión autenticada, nunca del cuerpo del request). Además patchea
   * `proposal.generation_report.technical` con los IDs de documento de
   * empresa REALMENTE usados (para que `computeCurrentInputsHash` los cubra)
   * y los requisitos "NO APLICA" (para que `buildAssembleInput` los pueda
   * reflejar en el manifiesto final, nunca omitidos en silencio).
   */
  saveTechnicalSections(
    organizationId: string,
    proposalId: string,
    input: {
      actorId: string;
      sections: readonly { sectionKey: string; label: string; content: string }[];
      usedCompanyDocumentIds: readonly string[];
      notApplicableRequirements: readonly { requirementId: string; reason: string }[];
    },
  ): Promise<ProposalRecord>;

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
  SubmissionRecord,
  RequiredAnnexItem,
} from "./types.ts";
export type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
export type { ProposalVersion, ProposalInputRecord, PersistedProposalVersion } from "./proposal-version-registry.ts";
