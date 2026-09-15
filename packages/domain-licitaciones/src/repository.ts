// Puerto de acceso a datos de domain-licitaciones — mismo patrón dual de
// adaptador que domain-hoteles/domain-restaurantes (ver diseño Fase 1 §3.2).
// Ningún flujo de apps/api toca SQL directamente — todo pasa por aquí.
import type {
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  CompanyCapabilityRecord,
  CompanyExperienceItemRecord,
  CompanySignerRecord,
  PackageManifestRecord,
  SubmissionRecord,
  RequiredAnnexItem,
  MatchingProfileRecord,
  GoNoGoDecisionRecord,
  TenderResolutionRecord,
} from "./types.ts";
import type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
import type { ExpedienteInputs, HashedInputs } from "./sealed-inputs.ts";
import type { PersistedProposalVersion } from "./proposal-version-registry.ts";
import type { LicitacionesRole } from "./roles.ts";
import type { EligibilityStatus } from "./matching-engine.ts";
import type { PersistedTenderVersion } from "./tender-version-registry.ts";
import type { SourceConnectorId } from "./connector-registry.ts";
import type { SourceFreshnessRecord, SourceRunInput, SourceRunRecord } from "./source-run.ts";
import type { ContractStatus } from "./contract-lifecycle.ts";
import type { ContractFieldKey } from "./contract-extraction.ts";
import type { ContractInvoiceStatus } from "./contract-billing.ts";
import type { DecimalString } from "./money.ts";
import type { InconformidadFundamento, InconformidadViability } from "./inconformidad.ts";
import type { CriteriaComparisonItem, OwnProposalStatus } from "./fallo-autopsy.ts";
import type { TenderSourceIngestCandidate } from "./connectors/types.ts";
import type { TenderResolution } from "./tender-resolution.ts";

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

/** Página de `listTendersPage` -- mismo criterio de forma que
 * `CitasRepository::CustomerPage` (@atiende/domain-citas): `total` es el conteo
 * completo (no solo `items.length`), `nextOffset` es `null` cuando ya no queda
 * página siguiente. */
export interface TenderPage {
  readonly items: readonly TenderRecord[];
  readonly total: number;
  readonly nextOffset: number | null;
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

// ---- Fase 5 pieza 2: historial de versiones de convocatoria (REQ-017/041/151..155) ----

/** Notificación inmediata (REQ-151/155) de una versión de convocatoria nueva o de una cascada de invalidación detectada. Sin canal de envío real (email/SMS) -- se persiste como registro consultable, mismo criterio "honesto" que el resto del backoffice (ver `FuentesFrescuraPage`/`PanelPage` del repo origen: nunca se finge una integración de envío que no existe). */
export interface TenderChangeNotificationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly reason: string;
  readonly changedFieldNames: readonly string[];
  readonly affectedSectionKeys: readonly string[];
  readonly notifiedRoles: readonly LicitacionesRole[];
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}

// ---------------------------------------------------------------------------
// Fase 8 -- ingesta automática real (compras_mx_historico) + recordatorios
// automáticos de plazo (REQ-004/146..150 + el gap de la auditoría: "worker
// no invoca ningún conector, no hay recordatorios automáticos de plazo").
// ---------------------------------------------------------------------------

export interface TenderSourceIngestResult {
  readonly created: number;
  readonly updated: number;
  readonly tenders: readonly TenderRecord[];
}

/** Recordatorio persistido de un vencimiento próximo (`submissionDeadline`) -- mismo criterio "honesto" que `TenderChangeNotificationRecord`: sin canal de envío real (email/SMS/WhatsApp), un registro consultable/reconocible (ver README del vertical para el gap declarado de integrar un canal real). */
export interface TenderDeadlineReminderRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly submissionDeadline: string;
  /** Redondeado hacia arriba (`Math.ceil`) respecto del momento en que se generó el recordatorio -- puede ser 0 si el vencimiento es HOY. */
  readonly daysRemaining: number;
  readonly message: string;
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
}

export interface ScanDeadlineRemindersInput {
  /** Ventana de anticipación (días) para considerar un vencimiento "próximo". Por defecto 3 (mismo valor que el repo origen, `deadline-reminders.ts::DeadlineReminderOptions.windowDays`). */
  readonly windowDays?: number;
  /** Inyectable SOLO para pruebas deterministas -- por defecto el momento real de la corrida. */
  readonly nowIso?: string;
}

export interface ScanDeadlineRemindersResult {
  readonly scanned: number;
  /** Cantidad de recordatorios REALMENTE creados en esta corrida (excluye los que ya existían -- dedupe por (tender, fecha calendario del vencimiento), mismo criterio que `enqueueUpcomingDeadlineReminders` del repo origen). */
  readonly created: number;
  /** Solo los recordatorios CREADOS en esta corrida (no el historial completo -- para eso ver `listTenderDeadlineReminders`). */
  readonly reminders: readonly TenderDeadlineReminderRecord[];
}

export interface RecordTenderVersionResult {
  readonly version: PersistedTenderVersion;
  /** `false` si el snapshot actual es idéntico al de la última versión persistida -- no se creó fila nueva ni se disparó cascada (REQ-152/154: dedupe + reprocesamiento idempotente). */
  readonly created: boolean;
  /** `ChangeDetected` efectivamente aplicados sobre la propuesta abierta de esta convocatoria (vacío si no existe propuesta, o si el cambio no afectó ningún alcance con aprobación vigente). */
  readonly cascadedChanges: readonly ChangeDetected[];
  /** `null` únicamente cuando `created === false`. */
  readonly notification: TenderChangeNotificationRecord | null;
}

// ---------------------------------------------------------------------------
// Fase 6 -- seguimiento post-adjudicación (REQ-051..055). Mismo criterio de
// forma que el resto de este archivo: uniones de string LITERALES en vez de
// reimportar el enum del módulo de dominio cuando el tipo es simple (p. ej.
// `InconformidadDraftRecord.status`), pero SÍ se importan los tipos "cerrado
// por catálogo en código" (`ContractStatus`, `ContractFieldKey`) porque son
// la fuente de verdad de una máquina de estados/extractor, no un enum trivial.
// ---------------------------------------------------------------------------

export interface ContractRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly status: ContractStatus;
  readonly endDate: string | null;
  readonly contractNumber: string | null;
  readonly hasRenewalOption: boolean;
  readonly renewalOptionNotes: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContractStatusHistoryRecord {
  readonly id: string;
  readonly contractId: string;
  readonly fromStatus: ContractStatus | null;
  readonly toStatus: ContractStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly evidenceRef: string | null;
  readonly createdAt: string;
}

export interface ContractMetadataUpdateInput {
  readonly endDate?: string | null;
  readonly contractNumber?: string | null;
  readonly hasRenewalOption?: boolean;
  readonly renewalOptionNotes?: string | null;
}

export interface ContractTransitionInput {
  readonly toStatus: string;
  readonly reason: string;
  readonly evidenceRef: string | null;
  readonly actorId: string;
}

// ---------------------------------------------------------------------
// Fase 16 -- resolución won/lost de una convocatoria (ver tender-resolution.ts).
// ---------------------------------------------------------------------
export interface TenderResolutionCreateInput {
  readonly resolution: TenderResolution;
  readonly reason: string;
  readonly actorId: string;
}

// ---------------------------------------------------------------------
// Fase 16 -- escritura de "datos de empresa" (company data): hasta esta
// pieza `LicitacionesRepository` solo exponía lectura (`listCompanyDocuments`/
// `listApprovedRates`/`listCompanyCapabilities`/`listCompanyExperience`/
// `listCompanySigners`) -- sin forma de capturar el dato real, toda propuesta
// (técnica o económica) que dependiera de él quedaba PENDIENTE para siempre
// (ver `company-data.ts::CompanyDataService`: dato ausente -> "missing"
// explícito, nunca inventado). `approvalStatus` es escribible por las mismas
// WRITE_ROLES que el resto de la captura (mismo criterio EXACTO que la
// migración 009 -- "aprobado" aquí es una marca de captura correcta, no una
// decisión de riesgo, a diferencia de aprobar el expediente completo).
// ---------------------------------------------------------------------
export type CompanyDataApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

export interface CompanyDocumentCreateInput {
  readonly type: string;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}
export interface CompanyDocumentUpdateInput {
  readonly label?: string;
  readonly expiresAt?: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}

export interface ApprovedRateCreateInput {
  readonly concept: string;
  readonly unitPrice: DecimalString;
  readonly validFrom?: string;
  readonly validUntil?: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}
export interface ApprovedRateUpdateInput {
  readonly unitPrice?: DecimalString;
  readonly validFrom?: string;
  readonly validUntil?: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}

export interface CompanyCapabilityCreateInput {
  readonly name: string;
  readonly description: string;
  readonly evidenceDocId?: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}
export interface CompanyCapabilityUpdateInput {
  readonly description?: string;
  readonly evidenceDocId?: string | null;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}

export interface CompanyExperienceCreateInput {
  readonly description: string;
  readonly evidenceDocId: string;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}
export interface CompanyExperienceUpdateInput {
  readonly description?: string;
  readonly evidenceDocId?: string;
  readonly approvalStatus?: CompanyDataApprovalStatus;
}

export interface CompanySignerCreateInput {
  readonly name: string;
  readonly role: string;
  readonly authorized?: boolean;
}
export interface CompanySignerUpdateInput {
  readonly name?: string;
  readonly authorized?: boolean;
}

export interface ContractDocumentRecord {
  readonly id: string;
  readonly contractId: string;
  readonly documentLabel: string;
  readonly pageCount: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export interface ContractExtractedFieldRecord {
  readonly id: string;
  readonly contractDocumentId: string;
  readonly fieldKey: ContractFieldKey;
  readonly extractedValue: string;
  readonly sourcePage: number | null;
  readonly sourceClause: string | null;
  readonly confidence: number;
  readonly status: "sugerido" | "confirmado" | "corregido";
  readonly confirmedValue: string | null;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

export interface AddContractDocumentInput {
  readonly documentLabel: string;
  /** Texto YA EXTRAÍDO por página -- ver límite documentado en contract-extraction.ts (no hay pipeline de PDF/OCR en este monorepo). */
  readonly pages: readonly { page: number; text: string }[];
  readonly actorId: string;
}

export interface ConfirmContractExtractedFieldInput {
  readonly action: "confirm" | "correct";
  readonly correctedValue: string | null;
  readonly actorId: string;
}

export interface ContractInvoiceRecord {
  readonly id: string;
  readonly contractId: string;
  readonly concepto: string;
  readonly amount: DecimalString;
  readonly invoiceVerifiedOn: string;
  readonly dueDate: string;
  readonly legalReference: string;
  readonly paidAt: string | null;
  readonly status: ContractInvoiceStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateContractInvoiceInput {
  readonly concepto: string;
  readonly amount: DecimalString;
  readonly invoiceVerifiedOn: string;
  readonly actorId: string;
}

export interface ReceivablesSummary {
  readonly asOfDate: string;
  readonly totalPending: DecimalString;
  readonly totalOverdue: DecimalString;
  readonly countPending: number;
  readonly countOverdue: number;
  readonly invoices: readonly ContractInvoiceRecord[];
}

export interface InconformidadDraftRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly version: number;
  readonly status: "borrador" | "revisado";
  readonly contentHash: string;
  readonly hechos: readonly string[];
  readonly agravios: readonly string[];
  readonly pruebas: readonly string[];
  readonly fundamentos: readonly InconformidadFundamento[];
  readonly falloNotifiedOn: string;
  readonly bajoTratados: boolean;
  readonly businessDays: number;
  readonly dueDate: string;
  readonly legalReference: string;
  readonly viability: InconformidadViability;
  readonly viabilityRecommendation: string;
  readonly disclaimer: string;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateInconformidadDraftInput {
  readonly hechos: readonly string[];
  readonly agravios: readonly string[];
  readonly pruebas: readonly string[];
  readonly falloNotifiedOn: string;
  readonly bajoTratados: boolean;
  readonly actorId: string;
}

export interface FalloAutopsyRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly ownProposalStatus: OwnProposalStatus;
  readonly disqualificationReason: string;
  readonly ownScore: number | null;
  readonly winnerScore: number | null;
  readonly ownPrice: number | null;
  readonly winnerPrice: number | null;
  readonly winnerName: string;
  readonly criteriaComparison: readonly CriteriaComparisonItem[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CreateFalloAutopsyInput {
  readonly ownProposalStatus: OwnProposalStatus;
  readonly disqualificationReason: string | null;
  readonly ownScore: number | null;
  readonly winnerScore: number | null;
  readonly ownPrice: number | null;
  readonly winnerPrice: number | null;
  readonly winnerName: string | null;
  readonly criteriaComparison: readonly CriteriaComparisonItem[];
  readonly lessons: readonly string[];
  readonly actorId: string;
}

export interface CompanyLessonLearnedRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly falloAutopsyId: string;
  readonly tenderId: string;
  readonly lessonText: string;
  readonly createdAt: string;
}

export interface RenewalAlertRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly contractId: string;
  readonly tenderId: string;
  readonly predictedDate: string;
  readonly leadDays: number;
  readonly confidence: number;
  readonly status: "pendiente" | "reconocida";
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly createdAt: string;
}

export interface ScanRenewalAlertsInput {
  readonly leadDaysThresholds?: readonly number[];
  /** Inyectable solo para pruebas deterministas -- por defecto la fecha real de hoy. */
  readonly todayIsoDate?: string;
}

export interface ScanRenewalAlertsResult {
  readonly evaluatedContracts: number;
  readonly alertsCreated: number;
  readonly alerts: readonly RenewalAlertRecord[];
}

// ---------------------------------------------------------------------------
// Fase 10 -- despacho proactivo real de las 3 alertas de arriba
// (tender_deadline_reminder, renewal_alert, contract_invoice vencida) vía
// correo (ver src/alert-notifications.ts, src/email-dispatch.ts,
// migrations/018_alert_notifications.sql). Mismo shape de tipos que
// domain-citas/domain-rentas (`EmailOutboxJobRow`), sin `whatsapp` en la
// unión de canal -- este vertical no tiene ese canal (ver comentario de
// cabecera de la migración 018).
// ---------------------------------------------------------------------------

export interface EmailOutboxJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

/** El "responsable de la organización" al que se le manda el correo de alerta -- staff con `platform_role` `owner`/`admin` (ver `licitaciones.organization_notification_recipients`, migración 018). Puede ser una lista vacía (organización sin owner/admin -- ver comentario de `enqueueAlertEmailsCore` en alert-notifications.ts para qué pasa en ese caso: nunca lanza, simplemente no hay a quién avisar). */
export interface OrganizationNotificationRecipient {
  readonly email: string;
  readonly fullName: string;
}

/** Factura vencida (`ContractInvoiceStatus === 'vencida'`) de CUALQUIER contrato de la organización -- a diferencia de `listContractInvoices`/`receivablesSummary` (acotados a un `tenderId`), este método barre TODOS los contratos de la organización de una sola vez, lo que necesita un barrido periódico transversal (ver `apps/worker/src/jobs/licitaciones/alert-notifications.ts::runCollectionAlertSweep`). `daysOverdue` SIEMPRE >= 1 (por construcción: solo incluye status 'vencida', que exige `today > dueDate`). */
export interface OverdueContractInvoiceAlert {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly contractId: string;
  readonly tenderId: string;
  readonly concepto: string;
  readonly amount: DecimalString;
  readonly dueDate: string;
  readonly daysOverdue: number;
}

export interface LicitacionesRepository {
  // ---- Fase 7 pieza 1: resolución de organización/property para el panel web ----
  /** Mismo rol que `CitasRepository.findOrganizationBySlug` — el panel solo conoce
   * el slug de la organización tras el login (nunca un `organizationId`/`propertyId`,
   * ver `GET /v1/licitaciones/:orgSlug/admin/branches` en admin.ts). */
  findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null>;
  /** Resuelve la(s) property(ies) de `core.property` de la organización — property
   * singleton por organización en licitaciones (§2.1 del diseño Fase 1), pero el
   * panel igual lee la lista completa (mismo criterio que citas/restaurantes: nunca
   * asumir cardinalidad en el cliente). */
  listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]>;

  // ---- Convocatoria / expediente (transversal) ----
  findTender(organizationId: string, tenderId: string): Promise<TenderRecord | null>;
  getOrCreateProposal(organizationId: string, tenderId: string, userId: string, title: string): Promise<ProposalRecord>;
  findProposal(organizationId: string, tenderId: string): Promise<ProposalRecord | null>;

  // ---- Fase 3 pieza 1: alta manual de convocatoria (§6) ----
  /** Lista TODAS las convocatorias de la organización (para `GET .../tenders/matching`, la vista de lista) -- sin paginar en esta fase (mismo criterio de simplicidad que el resto de listas de Fase 1/2). */
  listTenders(organizationId: string): Promise<readonly TenderRecord[]>;
  /** Versión PAGINADA de `listTenders`, para `GET /licitaciones/:propertyId/tenders`
   * (el listado que el panel navega) -- hallazgo de auditoría (rubro 10, "performance
   * y escalabilidad", severidad BAJA: "listados sin paginación en 4 verticales"). Una
   * organización activa acumula cientos/miles de convocatorias a lo largo de los
   * años; la query ahora está acotada por `limit`/`offset` reales. `listTenders`
   * (arriba) se queda INTACTA a propósito -- `matching.ts` la usa para calcular score
   * contra TODAS las convocatorias, nunca solo una página; paginar esa función
   * truncaría el matching real. */
  listTendersPage(organizationId: string, opts: { readonly limit: number; readonly offset: number }): Promise<TenderPage>;
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
  /** Fase 4 -- alimenta CompanyDataResolver.getCapabilities/getExperience/getSigners,
   * consumidos por TechnicalProposalBuilder para requisitos tipo capacidad/experiencia/
   * firmante. Sin filtro de vigencia (a diferencia de listApprovedRates): la aprobación
   * es el único gate, no hay fecha de vigencia en el dominio para estos tres. */
  listCompanyCapabilities(organizationId: string): Promise<readonly CompanyCapabilityRecord[]>;
  listCompanyExperience(organizationId: string): Promise<readonly CompanyExperienceItemRecord[]>;
  listCompanySigners(organizationId: string): Promise<readonly CompanySignerRecord[]>;

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

  // ---- Fase 5 pieza 2: historial de versiones de convocatoria (REQ-017/041/151..155) ----
  /**
   * Calcula el snapshot ACTUAL de la convocatoria (campos de bases +
   * `requirement_item` vigentes), lo compara contra la última
   * `licitaciones.tender_version` persistida y, si difiere (o si nunca hubo
   * una versión previa), persiste la nueva versión en la MISMA operación que:
   * (a) invalida -- vía `recordChange` -- la aprobación "expediente" vigente
   * si cambió algún campo de bases, y/o las aprobaciones de sección
   * dependientes (`seccion:<key>`, ver `SECTION_KEY_BY_REQUIREMENT_TYPE`) si
   * cambió algún requisito de ese tipo (REQ-155); y (b) registra una
   * notificación inmediata (REQ-151) dirigida a `WRITE_ROLES`. Idempotente
   * (REQ-154): si el snapshot es idéntico al de la última versión, no crea
   * fila/cascada/notificación nueva -- ver `RecordTenderVersionResult.created`.
   */
  recordTenderVersion(organizationId: string, tenderId: string, actorId: string): Promise<RecordTenderVersionResult>;
  /** Historial COMPLETO de versiones (REQ-153), más antigua primero. */
  listTenderVersions(organizationId: string, tenderId: string): Promise<readonly PersistedTenderVersion[]>;
  latestTenderVersion(organizationId: string, tenderId: string): Promise<PersistedTenderVersion | null>;
  /** Notificaciones de cambio de convocatoria, más recientes primero. Sin `tenderId`, lista las de TODA la organización (bandeja de "roles responsables"). */
  listTenderChangeNotifications(organizationId: string, tenderId?: string): Promise<readonly TenderChangeNotificationRecord[]>;
  acknowledgeTenderChangeNotification(organizationId: string, notificationId: string, actorId: string): Promise<TenderChangeNotificationRecord>;

  // ---- Fase 5 pieza 1: andamiaje de ingesta sobre fixtures/carga manual (REQ-004/005/146..150) ----
  /** Registra una corrida de un conector (hoy, siempre "manual" -- ver `connector-registry.ts`) con su estado explícito (REQ-148) y evidencia/cobertura (REQ-147). */
  recordSourceRun(organizationId: string, input: SourceRunInput): Promise<SourceRunRecord>;
  /** Historial de corridas, más recientes primero -- reconstruye el historial completo de una fuente (REQ-147). */
  listSourceRuns(organizationId: string, filter?: { source?: SourceConnectorId; limit?: number }): Promise<readonly SourceRunRecord[]>;
  /** Frescura/obsolescencia por fuente REGISTRADA (REQ-149) -- incluye toda fuente del registro único aunque nunca haya corrido (frescura `stale: true` explícita, nunca oculta). */
  sourceFreshness(organizationId: string): Promise<readonly SourceFreshnessRecord[]>;

  // ---- Fase 8: ingesta AUTOMÁTICA real + recordatorios de plazo ----
  /**
   * Upsert por `(organizationId, source, externalId)` -- MISMO mecanismo de
   * dedupe/conflicto que `upsertTenderManual` (reutiliza el mismo índice
   * único `tender_org_source_external_idx`), pero para un conector
   * AUTOMATIZADO: `source` es SIEMPRE el id del conector invocante (lanza si
   * se pasa `"manual"` -- ese camino de escritura sigue siendo
   * `upsertTenderManual`, nunca este) y `created_by` queda `null` (sin actor
   * humano detrás). A diferencia de `upsertTenderManual`, esta operación NO
   * llama `recordTenderVersion` ni escribe en `tender_audit_log`: esa
   * cascada de invalidación de aprobaciones y esa auditoría están
   * pensadas para un cambio sobre una convocatoria que un humano ya está
   * trabajando (`tender_audit_log.actor_id` es `NOT NULL` con FK a
   * `core.staff_user`, que una ingesta automática no puede satisfacer
   * honestamente sin inventar un actor). La evidencia de ESTA operación es
   * responsabilidad del llamador vía `recordSourceRun` (ver
   * `apps/worker/src/jobs/licitaciones/discover-tenders.ts`) -- mismo
   * principio de REQ-147 que ya aplicaba a `upsertTenderManual`, solo que
   * agregado por corrida completa en vez de por registro individual (un
   * conector automatizado puede traer cientos de filas por corrida).
   */
  ingestTendersFromSource(organizationId: string, source: SourceConnectorId, records: readonly TenderSourceIngestCandidate[]): Promise<TenderSourceIngestResult>;
  /** Organizaciones activas del vertical `licitaciones` -- mismo rol que `CitasRepository.listActiveOrganizations()`/`HotelesRepository.listActiveHotelProperties()` para el barrido de un scheduler externo (ver `apps/worker/src/jobs/licitaciones/discover-tenders.ts`, `deadline-reminders.ts`). */
  listActiveOrganizations(): Promise<readonly { id: string }[]>;
  /** Escanea `tender.submissionDeadline` de la organización y persiste un recordatorio nuevo por cada (convocatoria, fecha calendario de vencimiento) que no exista todavía -- idempotente: reescanear dentro de la misma ventana nunca duplica (mismo criterio que `scanRenewalAlerts`/`enqueueUpcomingDeadlineReminders` del repo origen). Excluye convocatorias en un estado terminal (`cancelled`/`lost`/`won`/`submitted`) -- ya no tiene sentido recordarles un plazo. */
  scanUpcomingDeadlineReminders(organizationId: string, input?: ScanDeadlineRemindersInput): Promise<ScanDeadlineRemindersResult>;
  /** Historial de recordatorios, más recientes primero. Sin `tenderId`, lista los de TODA la organización. */
  listTenderDeadlineReminders(organizationId: string, tenderId?: string): Promise<readonly TenderDeadlineReminderRecord[]>;
  acknowledgeTenderDeadlineReminder(organizationId: string, reminderId: string, actorId: string): Promise<TenderDeadlineReminderRecord>;

  // ---- Idempotencia (transversal) ----
  withIdempotency<T>(params: IdempotencyParams, run: () => Promise<IdempotentResult<T>>): Promise<IdempotentResult<T>>;

  // ---------------------------------------------------------------------
  // Fase 6 -- seguimiento post-adjudicación (REQ-051..055).
  // ---------------------------------------------------------------------

  /** REQ-051: alta del contrato en estado inicial `CONTRACT_INITIAL_STATUS` + primera fila de historial (`fromStatus: null`). Lanza si ya existe un contrato para este `tenderId` (un tender tiene a lo más un contrato, mismo criterio que `licitaciones.tender`/`licitaciones.proposal`). */
  createContract(organizationId: string, tenderId: string, actorId: string): Promise<ContractRecord>;
  findContractByTender(organizationId: string, tenderId: string): Promise<ContractRecord | null>;
  /** REQ-055: metadatos administrativos (fecha de fin/número de contrato/opción de renovación) -- NO es una transición de estado, no genera fila de historial; es el insumo directo del radar de renovaciones. */
  updateContractMetadata(organizationId: string, tenderId: string, input: ContractMetadataUpdateInput): Promise<ContractRecord>;
  /** Valida con `checkTransition` (contract-lifecycle.ts) -- lanza `ContractTransitionRejectedError` si `toStatus` no es alcanzable desde el estado actual, sin tocar ninguna fila. Si la transición es válida, actualiza `contracts.status` y agrega una fila a `contract_status_history` en la MISMA operación. */
  transitionContract(organizationId: string, tenderId: string, input: ContractTransitionInput): Promise<ContractRecord>;
  /** Historial COMPLETO e inmutable de transiciones, más antigua primero. */
  listContractStatusHistory(organizationId: string, tenderId: string): Promise<readonly ContractStatusHistoryRecord[]>;

  /** REQ-052: registra un documento de contrato con texto YA EXTRAÍDO por página y corre `extractContractFields` sobre él -- todo campo detectado entra como `status: 'sugerido'`, nunca confirmado automáticamente. */
  addContractDocument(organizationId: string, tenderId: string, input: AddContractDocumentInput): Promise<{ document: ContractDocumentRecord; fields: readonly ContractExtractedFieldRecord[] }>;
  listContractDocuments(organizationId: string, tenderId: string): Promise<readonly ContractDocumentRecord[]>;
  listContractExtractedFields(organizationId: string, tenderId: string, documentId: string): Promise<readonly ContractExtractedFieldRecord[]>;
  /** REQ-052: "el usuario confirma o corrige; nunca se dan por válidos sin confirmación" -- mueve el campo de `'sugerido'` a `'confirmado'`/`'corregido'`. */
  confirmContractExtractedField(organizationId: string, tenderId: string, fieldId: string, input: ConfirmContractExtractedFieldInput): Promise<ContractExtractedFieldRecord>;

  /** REQ-051 (cobranza): registra una factura contra el contrato -- el vencimiento SIEMPRE se calcula server-side (`contract-billing.ts::computePaymentDueDate`, Art. 73 LAASSP, 17 días hábiles), nunca lo declara el cliente. */
  createContractInvoice(organizationId: string, tenderId: string, input: CreateContractInvoiceInput): Promise<ContractInvoiceRecord>;
  /** `status` de cada factura se recalcula en cada lectura contra la fecha real de hoy (`classifyInvoiceStatus`) -- nunca se sirve un `status` persistido que pueda haber quedado obsoleto. */
  listContractInvoices(organizationId: string, tenderId: string): Promise<readonly ContractInvoiceRecord[]>;
  markContractInvoicePaid(organizationId: string, tenderId: string, invoiceId: string, actorId: string): Promise<ContractInvoiceRecord>;
  /** Vista de negocio: totales pendiente/vencido (Decimal, nunca `number` flotante) + el detalle completo de facturas -- la "alerta" de cobranza de esta fase es este campo `status`/los totales, calculados en vivo (mismo criterio "sin cola de trabajos" que el resto de Fase 6, ver README del vertical). */
  receivablesSummary(organizationId: string, tenderId: string): Promise<ReceivablesSummary>;

  /** REQ-053: genera una VERSIÓN nueva del borrador (nunca edita una existente, ver migración de inconformidad_draft) -- el contenido (fundamentos/plazo/viabilidad) lo calcula `inconformidad.ts::buildInconformidadContent`, nunca el cliente. */
  createInconformidadDraft(organizationId: string, tenderId: string, input: CreateInconformidadDraftInput): Promise<InconformidadDraftRecord>;
  listInconformidadDrafts(organizationId: string, tenderId: string): Promise<readonly InconformidadDraftRecord[]>;
  /** Única transición de estado posible: `'borrador'` -> `'revisado'` -- lanza si ya estaba revisado (mismo criterio "hecho histórico inmutable" que `go_no_go_decision`). */
  markInconformidadReviewed(organizationId: string, tenderId: string, draftId: string, actorId: string): Promise<InconformidadDraftRecord>;

  /** REQ-054: registra la autopsia del fallo + las lecciones aprendidas asociadas en la MISMA operación -- campos textuales ausentes se normalizan a `NO_DISPONIBLE` (`fallo-autopsy.ts`), nunca `null`/"" ambiguo. */
  createFalloAutopsy(organizationId: string, tenderId: string, input: CreateFalloAutopsyInput): Promise<{ autopsy: FalloAutopsyRecord; lessons: readonly CompanyLessonLearnedRecord[] }>;
  listFalloAutopsies(organizationId: string, tenderId: string): Promise<readonly FalloAutopsyRecord[]>;
  /** Lecciones vinculadas al PERFIL DE EMPRESA (org-wide, no solo la convocatoria puntual) -- consultable sin filtrar por tender. */
  listLessonsLearned(organizationId: string): Promise<readonly CompanyLessonLearnedRecord[]>;

  /** REQ-055: escanea TODOS los contratos con `endDate` conocida de la organización (excepto `cerrado`/`rescindido`) y persiste una alerta nueva por cada (contrato, umbral) recién cruzado que no exista todavía -- idempotente: reescanear no duplica alertas ya emitidas para el mismo umbral. */
  scanRenewalAlerts(organizationId: string, input: ScanRenewalAlertsInput): Promise<ScanRenewalAlertsResult>;
  /** Bandeja de alertas, más recientes primero. */
  listRenewalAlerts(organizationId: string): Promise<readonly RenewalAlertRecord[]>;
  acknowledgeRenewalAlert(organizationId: string, alertId: string, actorId: string): Promise<RenewalAlertRecord>;

  // ---------------------------------------------------------------------
  // Fase 10 -- despacho proactivo real (correo) de las alertas de arriba.
  // ---------------------------------------------------------------------

  /** Staff `owner`/`admin` de la organización, el "responsable" al que se le manda el correo de alerta (ver `OrganizationNotificationRecipient`). */
  listOrganizationNotificationRecipients(organizationId: string): Promise<readonly OrganizationNotificationRecipient[]>;
  /** Barre TODOS los contratos de la organización (no uno solo, a diferencia de `listContractInvoices`) buscando facturas `vencida` -- insumo directo del barrido de cobranza (`runCollectionAlertSweep`). `todayIsoDate` inyectable SOLO para pruebas deterministas, por defecto la fecha real de hoy. */
  listOverdueContractInvoices(organizationId: string, todayIsoDate?: string): Promise<readonly OverdueContractInvoiceAlert[]>;
  /** Encola (`channel='email'`) el envío real -- mismo rol que `CitasRepository.enqueueMessagingOutbox`/`RentasRepository.enqueueMessagingOutbox`. `channel` se deja como parámetro (en vez de fijarlo a 'email' en la firma) por SIMETRÍA con el resto del monorepo -- este vertical hoy solo implementa 'email' (ver migración 018), pasar cualquier otro valor lanza. */
  enqueueMessagingOutbox(organizationId: string, channel: "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  /** Reclama hasta `limit` jobs `channel='email'` pendientes/fallidos -- ver `licitaciones.claim_email_outbox_batch` (migración 018). */
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;

  // ---------------------------------------------------------------------
  // Fase 16 -- resolución won/lost (ver tender-resolution.ts) + escritura de
  // "datos de empresa" (ver bloque de tipos *CreateInput/*UpdateInput arriba).
  // ---------------------------------------------------------------------

  /** Valida con `checkTenderResolution` (tender-resolution.ts) -- lanza `TenderResolutionRejectedError` si el `status` actual de la convocatoria no está en `TENDER_RESOLVABLE_FROM_STATUSES`, sin tocar ninguna fila. Si es válida, actualiza `licitaciones.tender.status` y agrega una fila a `licitaciones.tender_resolution` en la MISMA operación. */
  resolveTender(organizationId: string, tenderId: string, input: TenderResolutionCreateInput): Promise<TenderRecord>;
  /** Historial COMPLETO e inmutable de resoluciones, más antigua primero (normalmente una sola fila: won/lost son terminales, pero el historial se conserva igual que `contract_status_history`). */
  listTenderResolutions(organizationId: string, tenderId: string): Promise<readonly TenderResolutionRecord[]>;

  /** Lanza `CompanyDataDuplicateKeyError` -- ninguna clave natural en este bloque (`approved_rate.concept`, `company_capability.name`, `company_signer.role`). `company_document`/`company_experience` no tienen clave natural: crear siempre inserta una fila nueva. Los 5 métodos `update*` de este bloque lanzan `CompanyDataNotFoundError` cuando el `id` no corresponde a ningún registro de la organización -- `apps/api/.../companyData.ts::mapDuplicateOrThrow` depende de ese tipo (no de un `Error` genérico) para distinguir "no encontrado" (404) de cualquier otro fallo, que se propaga sin envolver. */
  createCompanyDocument(organizationId: string, input: CompanyDocumentCreateInput): Promise<CompanyDocumentRecord>;
  updateCompanyDocument(organizationId: string, documentId: string, input: CompanyDocumentUpdateInput): Promise<CompanyDocumentRecord>;
  createApprovedRate(organizationId: string, input: ApprovedRateCreateInput): Promise<ApprovedRateRecord>;
  updateApprovedRate(organizationId: string, rateId: string, input: ApprovedRateUpdateInput): Promise<ApprovedRateRecord>;
  /** A diferencia de `listApprovedRates` (filtra a solo aprobadas Y vigentes a `asOfIso`, el insumo real del motor económico), esta lista TODAS las tarifas de la organización sin filtrar -- la vista de administración necesita ver/editar también las pendientes/rechazadas/vencidas. */
  listAllApprovedRates(organizationId: string): Promise<readonly ApprovedRateRecord[]>;
  createCompanyCapability(organizationId: string, input: CompanyCapabilityCreateInput): Promise<CompanyCapabilityRecord>;
  updateCompanyCapability(organizationId: string, capabilityId: string, input: CompanyCapabilityUpdateInput): Promise<CompanyCapabilityRecord>;
  createCompanyExperience(organizationId: string, input: CompanyExperienceCreateInput): Promise<CompanyExperienceItemRecord>;
  updateCompanyExperience(organizationId: string, experienceId: string, input: CompanyExperienceUpdateInput): Promise<CompanyExperienceItemRecord>;
  createCompanySigner(organizationId: string, input: CompanySignerCreateInput): Promise<CompanySignerRecord>;
  updateCompanySigner(organizationId: string, signerId: string, input: CompanySignerUpdateInput): Promise<CompanySignerRecord>;
}

export type {
  TenderRecord,
  ProposalRecord,
  ComplianceItemRecord,
  CompanyDocumentRecord,
  ApprovedRateRecord,
  CompanyCapabilityRecord,
  CompanyExperienceItemRecord,
  CompanySignerRecord,
  PackageManifestRecord,
  SubmissionRecord,
  RequiredAnnexItem,
} from "./types.ts";
export type { Approval, ApprovalScope, ChangeDetected } from "./approval-workflow.ts";
export type { ProposalVersion, ProposalInputRecord, PersistedProposalVersion } from "./proposal-version-registry.ts";
export type { TenderVersion, PersistedTenderVersion, TenderVersionSnapshot, TenderFieldSnapshot, RequirementSnapshot, TenderVersionDiff, TenderFieldChange, TenderRequirementChange, TenderDiffStatus } from "./tender-version-registry.ts";
export type { SourceConnectorId, SourceHealthState, SourceConnectorDescriptor } from "./connector-registry.ts";
export type { SourceRunRecord, SourceRunInput, SourceRunEvidence, SourceFreshnessRecord } from "./source-run.ts";
export type { TenderSourceIngestCandidate } from "./connectors/types.ts";
