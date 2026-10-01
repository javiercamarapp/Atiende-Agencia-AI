// Puerto de privacidad (H-02). Separado de `HotelesRepository` y de `IdentityRepository` a
// proposito: todo lo de esta superficie degrada distinto (base sin la migracion 032 = "no
// disponible aun": lecturas vacias, escrituras 503; nunca el camino anterior de otro flujo).
//
// `actorUserId`: el adaptador Postgres lo IGNORA (la autoridad es `auth.uid()` de la sesion,
// ver migrations/032); existe para que el adaptador en memoria aplique doble control sin sesion real.
import type { IncidentActionInput } from "./parse.ts";
import type {
  ArcoRequestRecord,
  ArcoStatus,
  ArcoTargetStatus,
  BlockedAccessRequestRecord,
  BlockedAccessStatus,
  ConsentRecord,
  IncidentStatus,
  LegalHoldRecord,
  LegalHoldStatus,
  NewArcoRequestInput,
  NewConsentInput,
  NewIncidentInput,
  NewLegalHoldInput,
  NewPrivacyNoticeInput,
  PrivacyEventRecord,
  PrivacyEventSubject,
  PrivacyIncidentRecord,
  PrivacyListResult,
  PrivacyNoticeRecord,
  PrivacySettingsRecord,
} from "./types.ts";

export interface PrivacyRepository {
  /** Base sin 032: `available: false` y el default (7 dias). */
  getSettings(propertyId: string): Promise<{ readonly available: boolean; readonly settings: PrivacySettingsRecord }>;
  setBlockWindow(propertyId: string, days: number, actorUserId: string): Promise<void>;

  publishNotice(propertyId: string, input: NewPrivacyNoticeInput, actorUserId: string): Promise<string>;
  listNotices(propertyId: string, filters: { readonly limit: number }): Promise<PrivacyListResult<PrivacyNoticeRecord>>;
  findNotice(propertyId: string, noticeId: string): Promise<PrivacyNoticeRecord | null>;

  recordConsent(propertyId: string, input: NewConsentInput, actorUserId: string): Promise<ConsentRecord>;
  listConsents(propertyId: string, filters: { readonly guestId?: string; readonly vaultId?: string; readonly limit: number }): Promise<PrivacyListResult<ConsentRecord>>;
  revokeConsent(consentId: string, reason: string, actorUserId: string): Promise<void>;

  openArco(propertyId: string, input: NewArcoRequestInput, actorUserId: string): Promise<string>;
  listArco(propertyId: string, filters: { readonly status?: ArcoStatus; readonly limit: number }): Promise<PrivacyListResult<ArcoRequestRecord>>;
  findArco(propertyId: string, requestId: string): Promise<ArcoRequestRecord | null>;
  /** `today` = fecha de negocio de la property (la base la acota a +-1 dia de la fecha del servidor). */
  advanceArco(requestId: string, to: ArcoTargetStatus, note: string, today: string, actorUserId: string): Promise<ArcoTargetStatus>;
  extendArco(requestId: string, reason: string, actorUserId: string): Promise<void>;

  reportIncident(propertyId: string, input: NewIncidentInput, actorUserId: string): Promise<string>;
  listIncidents(propertyId: string, filters: { readonly status?: IncidentStatus; readonly limit: number }): Promise<PrivacyListResult<PrivacyIncidentRecord>>;
  findIncident(propertyId: string, incidentId: string): Promise<PrivacyIncidentRecord | null>;
  updateIncident(incidentId: string, action: IncidentActionInput, actorUserId: string): Promise<IncidentStatus>;

  placeLegalHold(input: NewLegalHoldInput, actorUserId: string): Promise<string>;
  listLegalHolds(propertyId: string, filters: { readonly vaultId?: string; readonly status?: LegalHoldStatus; readonly limit: number }): Promise<PrivacyListResult<LegalHoldRecord>>;
  findLegalHold(propertyId: string, holdId: string): Promise<LegalHoldRecord | null>;
  releaseLegalHold(holdId: string, note: string, actorUserId: string): Promise<void>;

  /** Bloqueo manual de una identidad activa (owner/gm). */
  blockIdentity(vaultId: string, reason: string, actorUserId: string): Promise<void>;
  requestBlockedAccess(vaultId: string, reason: string, actorUserId: string): Promise<string>;
  decideBlockedAccess(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"aprobada" | "rechazada">;
  listBlockedAccess(propertyId: string, filters: { readonly status?: BlockedAccessStatus; readonly limit: number }): Promise<PrivacyListResult<BlockedAccessRequestRecord>>;
  findBlockedAccess(propertyId: string, requestId: string): Promise<BlockedAccessRequestRecord | null>;

  listEvents(propertyId: string, filters: { readonly subjectType?: PrivacyEventSubject; readonly subjectId?: string; readonly limit: number }): Promise<PrivacyListResult<PrivacyEventRecord>>;
}
