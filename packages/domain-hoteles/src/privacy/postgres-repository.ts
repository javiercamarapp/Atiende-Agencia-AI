// Adaptador Postgres de privacidad (H-02) sobre `TenantDbSession` (auth.uid() real por request).
// REGLA DURA DE COMPATIBILIDAD: toda operacion corre dentro de `runWithSavepointFallback` --
// `dbSession` es UNA transaccion por request y un error de Postgres (p. ej. 42P01 en una base sin
// la migracion 032) la dejaria ABORTADA (25P02). Con SAVEPOINT la sesion queda utilizable: las
// lecturas degradan a vacio honesto (`available: false`), las escrituras a `PrivacyUnavailableError` (503).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { IdentityBlockedError, IdentityPurgedError } from "../identity/errors.ts";
import { PrivacyAccessDeniedError, PrivacyConflictError, PrivacyDoubleControlError, PrivacyInvalidInputError, PrivacyUnavailableError } from "./errors.ts";
import type { IncidentActionInput } from "./parse.ts";
import type { PrivacyRepository } from "./repository.ts";
import { BLOCK_WINDOW_DAYS_DEFAULT } from "./rules.ts";
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

const NOTICE_COLUMNS = `id, property_id, version, simplified_text, integral_url, mandatory_purposes, optional_purposes, content_sha256,
       is_current, published_by, published_at::text as published_at`;
const CONSENT_COLUMNS = `id, property_id, guest_id, vault_id, notice_id, notice_version, accepted_mandatory, accepted_optional, channel,
       evidence_method, sensitive_data, consented_at::text as consented_at, captured_by, revoked_at::text as revoked_at, revoked_by, revoke_reason`;
const ARCO_COLUMNS = `id, property_id, folio, right_type, guest_id, vault_id, requester_name, requester_contact, channel, description,
       received_on::text as received_on, response_due_on::text as response_due_on, execution_due_on::text as execution_due_on, status,
       decided_on::text as decided_on, decision_note, extension_phase, extension_reason, extended_at::text as extended_at, extended_by,
       executed_at::text as executed_at, created_by, created_at::text as created_at`;
const INCIDENT_COLUMNS = `id, property_id, folio, incident_type, severity, title, description, detected_at::text as detected_at, affected_count,
       significant_risk, status, contained_at::text as contained_at, notified_at::text as notified_at, notified_by, notification_channel,
       notification_ref, no_notification_reason, closed_at::text as closed_at, closed_by, closing_note, reported_by, created_at::text as created_at`;
const HOLD_COLUMNS = `id, property_id, vault_id, incident_id, folio, reason, authorization_ref, status, placed_by, placed_at::text as placed_at,
       review_due_on::text as review_due_on, released_by, released_at::text as released_at, release_note`;
const ACCESS_COLUMNS = `id, property_id, vault_id, requested_by, reason, status, decided_by, decided_at::text as decided_at, decision_note,
       expires_at::text as expires_at, used_at::text as used_at, created_at::text as created_at`;
const EVENT_COLUMNS = `id, property_id, subject_type, subject_id, actor_user_id, action, note, created_at::text as created_at`;

type Row = Record<string, unknown>;
const s = (v: unknown): string => v as string;
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : (v as string));

const toNotice = (r: Row): PrivacyNoticeRecord => ({
  id: s(r.id), propertyId: s(r.property_id), version: s(r.version), simplifiedText: s(r.simplified_text), integralUrl: sn(r.integral_url),
  mandatoryPurposes: r.mandatory_purposes as string[], optionalPurposes: r.optional_purposes as string[], contentSha256: sn(r.content_sha256),
  isCurrent: r.is_current as boolean, publishedBy: sn(r.published_by), publishedAt: s(r.published_at),
});
const toConsent = (r: Row): ConsentRecord => ({
  id: s(r.id), propertyId: s(r.property_id), guestId: s(r.guest_id), vaultId: sn(r.vault_id), noticeId: s(r.notice_id), noticeVersion: s(r.notice_version),
  acceptedMandatory: r.accepted_mandatory as string[], acceptedOptional: r.accepted_optional as string[], channel: r.channel as ConsentRecord["channel"],
  evidenceMethod: r.evidence_method as ConsentRecord["evidenceMethod"], sensitiveData: r.sensitive_data as boolean, consentedAt: s(r.consented_at),
  capturedBy: sn(r.captured_by), revokedAt: sn(r.revoked_at), revokedBy: sn(r.revoked_by), revokeReason: sn(r.revoke_reason),
});
const toArco = (r: Row): ArcoRequestRecord => ({
  id: s(r.id), propertyId: s(r.property_id), folio: s(r.folio), rightType: r.right_type as ArcoRequestRecord["rightType"], guestId: sn(r.guest_id), vaultId: sn(r.vault_id),
  requesterName: s(r.requester_name), requesterContact: sn(r.requester_contact), channel: r.channel as ArcoRequestRecord["channel"], description: sn(r.description),
  receivedOn: s(r.received_on), responseDueOn: s(r.response_due_on), executionDueOn: sn(r.execution_due_on), status: r.status as ArcoStatus, decidedOn: sn(r.decided_on),
  decisionNote: sn(r.decision_note), extensionPhase: (r.extension_phase ?? null) as ArcoRequestRecord["extensionPhase"], extensionReason: sn(r.extension_reason),
  extendedAt: sn(r.extended_at), extendedBy: sn(r.extended_by), executedAt: sn(r.executed_at), createdBy: sn(r.created_by), createdAt: s(r.created_at),
});
const toIncident = (r: Row): PrivacyIncidentRecord => ({
  id: s(r.id), propertyId: s(r.property_id), folio: s(r.folio), incidentType: r.incident_type as PrivacyIncidentRecord["incidentType"],
  severity: r.severity as PrivacyIncidentRecord["severity"], title: s(r.title), description: s(r.description), detectedAt: s(r.detected_at),
  affectedCount: r.affected_count === null || r.affected_count === undefined ? null : Number(r.affected_count), significantRisk: r.significant_risk as boolean,
  status: r.status as IncidentStatus, containedAt: sn(r.contained_at), notifiedAt: sn(r.notified_at), notifiedBy: sn(r.notified_by),
  notificationChannel: sn(r.notification_channel), notificationRef: sn(r.notification_ref), noNotificationReason: sn(r.no_notification_reason),
  closedAt: sn(r.closed_at), closedBy: sn(r.closed_by), closingNote: sn(r.closing_note), reportedBy: sn(r.reported_by), createdAt: s(r.created_at),
});
const toHold = (r: Row): LegalHoldRecord => ({
  id: s(r.id), propertyId: s(r.property_id), vaultId: s(r.vault_id), incidentId: sn(r.incident_id), folio: s(r.folio), reason: s(r.reason),
  authorizationRef: s(r.authorization_ref), status: r.status as LegalHoldStatus, placedBy: s(r.placed_by), placedAt: s(r.placed_at), reviewDueOn: s(r.review_due_on),
  releasedBy: sn(r.released_by), releasedAt: sn(r.released_at), releaseNote: sn(r.release_note),
});
const toAccess = (r: Row): BlockedAccessRequestRecord => ({
  id: s(r.id), propertyId: s(r.property_id), vaultId: s(r.vault_id), requestedBy: s(r.requested_by), reason: s(r.reason), status: r.status as BlockedAccessStatus,
  decidedBy: sn(r.decided_by), decidedAt: sn(r.decided_at), decisionNote: sn(r.decision_note), expiresAt: sn(r.expires_at), usedAt: sn(r.used_at), createdAt: s(r.created_at),
});
const toEvent = (r: Row): PrivacyEventRecord => ({
  id: s(r.id), propertyId: s(r.property_id), subjectType: r.subject_type as PrivacyEventSubject, subjectId: sn(r.subject_id), actorUserId: sn(r.actor_user_id),
  action: s(r.action), note: sn(r.note), createdAt: s(r.created_at),
});

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
}
function pgMessage(err: unknown): string {
  return err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
}
const clean = (m: string): string => m.replace(/^[a-z_]+:\s*/, "");

/** Traduce los errores de las funciones/triggers de la migracion 032 a errores de dominio. Lo desconocido se repropaga (nunca se enmascara). */
export function mapPrivacyPgError(err: unknown, operation: string): unknown {
  const code = pgCode(err);
  const message = pgMessage(err);
  if (code === "42501") {
    if (message.startsWith("doble_control")) return new PrivacyDoubleControlError();
    if (message.startsWith("identidad_bloqueada")) return new IdentityBlockedError();
    if (message.startsWith("identidad_purgada")) return new IdentityPurgedError();
    if (message.startsWith("consentimiento_revocado") || message.startsWith("retencion_legal") || message.startsWith("purga_sin_bloqueo") || message.startsWith("bloqueo_vigente")) {
      return new PrivacyConflictError(clean(message));
    }
    return new PrivacyAccessDeniedError(operation);
  }
  if (code === "P0001") {
    if (message.startsWith("identidad_purgada")) return new IdentityPurgedError();
    if (message.startsWith("identidad_bloqueada")) return new IdentityBlockedError();
    return new PrivacyConflictError(clean(message) || "El estado actual no permite esta accion.");
  }
  if (code === "22023") return new PrivacyInvalidInputError(clean(message));
  if (code === "23503") return new PrivacyInvalidInputError(clean(message) || "Referencia invalida (huesped, identidad, aviso o incidente de otra property).");
  if (code === "23505") return new PrivacyConflictError("Ya existe un registro con ese folio, version o una solicitud abierta para el mismo objeto.");
  if (code === "23514") return new PrivacyInvalidInputError("Los datos no cumplen las restricciones del modelo (catalogo, longitud o coherencia de estado).");
  return err;
}

export class PostgresPrivacyRepository implements PrivacyRepository {
  constructor(private readonly db: TenantDbSession) {}

  private async write<T>(operation: string, functionName: string | undefined, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback({
        session: this.db,
        primary,
        isRecoverable: (e) => isMigrationPendingError(e, functionName),
        fallback: () => {
          throw new PrivacyUnavailableError(operation);
        },
      });
    } catch (err) {
      throw mapPrivacyPgError(err, operation);
    }
  }

  private read<T>(operation: string, primary: () => Promise<T>, unavailable: T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: (e) => isMigrationPendingError(e),
      fallback: () => {
        console.warn(`privacidad.${operation}: migracion 032 pendiente -- degradando a "no disponible aun".`);
        return Promise.resolve(unavailable);
      },
    });
  }

  private async list<T>(operation: string, sql: string, params: unknown[], map: (r: Row) => T): Promise<PrivacyListResult<T>> {
    return this.read<PrivacyListResult<T>>(
      operation,
      async () => {
        const { rows } = await this.db.query<Row>(sql, params);
        return { available: true, items: rows.map(map) };
      },
      { available: false, items: [] },
    );
  }

  private async find<T>(operation: string, sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> {
    return this.read<T | null>(
      operation,
      async () => {
        const { rows } = await this.db.query<Row>(sql, params);
        return rows[0] ? map(rows[0]) : null;
      },
      null,
    );
  }

  async getSettings(propertyId: string): Promise<{ available: boolean; settings: PrivacySettingsRecord }> {
    const fallback = { available: false, settings: { blockWindowDays: BLOCK_WINDOW_DAYS_DEFAULT, isDefault: true, updatedBy: null, updatedAt: null } };
    return this.read<{ available: boolean; settings: PrivacySettingsRecord }>(
      "settings",
      async () => {
        const { rows } = await this.db.query<Row>(`select block_window_days, updated_by, updated_at::text as updated_at from hoteles.privacy_settings where property_id = $1;`, [propertyId]);
        const r = rows[0];
        return {
          available: true,
          settings: r
            ? { blockWindowDays: Number(r.block_window_days), isDefault: false, updatedBy: sn(r.updated_by), updatedAt: sn(r.updated_at) }
            : { blockWindowDays: BLOCK_WINDOW_DAYS_DEFAULT, isDefault: true, updatedBy: null, updatedAt: null },
        };
      },
      fallback,
    );
  }

  async setBlockWindow(propertyId: string, days: number, actorUserId: string): Promise<void> {
    void actorUserId;
    await this.write("settings-set", "set_identity_block_window", async () => {
      await this.db.query(`select hoteles.set_identity_block_window($1, $2);`, [propertyId, days]);
    });
  }

  async publishNotice(propertyId: string, input: NewPrivacyNoticeInput, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("notice-publish", "publish_privacy_notice", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `select hoteles.publish_privacy_notice($1, $2, $3, $4::text[], $5::text[], $6, $7) as id;`,
        [propertyId, input.version, input.simplifiedText, input.mandatoryPurposes, input.optionalPurposes, input.integralUrl, input.contentSha256],
      );
      return rows[0]!.id;
    });
  }

  listNotices(propertyId: string, filters: { limit: number }): Promise<PrivacyListResult<PrivacyNoticeRecord>> {
    return this.list("notice-list", `select ${NOTICE_COLUMNS} from hoteles.privacy_notice where property_id = $1 order by published_at desc, id limit $2;`, [propertyId, filters.limit], toNotice);
  }
  findNotice(propertyId: string, noticeId: string): Promise<PrivacyNoticeRecord | null> {
    return this.find("notice-find", `select ${NOTICE_COLUMNS} from hoteles.privacy_notice where property_id = $1 and id = $2;`, [propertyId, noticeId], toNotice);
  }

  async recordConsent(propertyId: string, input: NewConsentInput, actorUserId: string): Promise<ConsentRecord> {
    void actorUserId; // el trigger sella captured_by = auth.uid()
    return this.write("consent-record", undefined, async () => {
      const { rows } = await this.db.query<Row>(
        `insert into hoteles.identity_consent (id, property_id, guest_id, vault_id, notice_id, accepted_mandatory, accepted_optional, channel, evidence_method, sensitive_data)
         values ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10)
         returning ${CONSENT_COLUMNS};`,
        [input.id, propertyId, input.guestId, input.vaultId, input.noticeId, input.acceptedMandatory, input.acceptedOptional, input.channel, input.evidenceMethod, input.sensitiveData],
      );
      return toConsent(rows[0]!);
    });
  }

  listConsents(propertyId: string, filters: { guestId?: string; vaultId?: string; limit: number }): Promise<PrivacyListResult<ConsentRecord>> {
    return this.list(
      "consent-list",
      `select ${CONSENT_COLUMNS} from hoteles.identity_consent
       where property_id = $1 and ($2::uuid is null or guest_id = $2) and ($3::uuid is null or vault_id = $3)
       order by consented_at desc, id limit $4;`,
      [propertyId, filters.guestId ?? null, filters.vaultId ?? null, filters.limit],
      toConsent,
    );
  }

  async revokeConsent(consentId: string, reason: string, actorUserId: string): Promise<void> {
    void actorUserId;
    await this.write("consent-revoke", "revoke_identity_consent", async () => {
      await this.db.query(`select hoteles.revoke_identity_consent($1, $2);`, [consentId, reason]);
    });
  }

  async openArco(propertyId: string, input: NewArcoRequestInput, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("arco-open", "open_arco_request", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `select hoteles.open_arco_request($1, $2, $3, $4, $5, $6, $7::date, $8, $9) as id;`,
        [propertyId, input.rightType, input.requesterName, input.requesterContact, input.channel, input.description, input.receivedOn, input.guestId, input.vaultId],
      );
      return rows[0]!.id;
    });
  }

  listArco(propertyId: string, filters: { status?: ArcoStatus; limit: number }): Promise<PrivacyListResult<ArcoRequestRecord>> {
    return this.list(
      "arco-list",
      `select ${ARCO_COLUMNS} from hoteles.arco_request where property_id = $1 and ($2::text is null or status = $2) order by response_due_on, created_at desc, id limit $3;`,
      [propertyId, filters.status ?? null, filters.limit],
      toArco,
    );
  }
  findArco(propertyId: string, requestId: string): Promise<ArcoRequestRecord | null> {
    return this.find("arco-find", `select ${ARCO_COLUMNS} from hoteles.arco_request where property_id = $1 and id = $2;`, [propertyId, requestId], toArco);
  }

  async advanceArco(requestId: string, to: ArcoTargetStatus, note: string, today: string, actorUserId: string): Promise<ArcoTargetStatus> {
    void actorUserId;
    return this.write("arco-advance", "advance_arco_request", async () => {
      const { rows } = await this.db.query<{ result: ArcoTargetStatus }>(`select hoteles.advance_arco_request($1, $2, $3, $4::date) as result;`, [requestId, to, note, today]);
      return rows[0]!.result;
    });
  }

  async extendArco(requestId: string, reason: string, actorUserId: string): Promise<void> {
    void actorUserId;
    await this.write("arco-extend", "extend_arco_request", async () => {
      await this.db.query(`select hoteles.extend_arco_request($1, $2);`, [requestId, reason]);
    });
  }

  async reportIncident(propertyId: string, input: NewIncidentInput, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("incident-report", "report_privacy_incident", async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `select hoteles.report_privacy_incident($1, $2, $3, $4, $5, $6::timestamptz, $7, $8) as id;`,
        [propertyId, input.incidentType, input.severity, input.title, input.description, input.detectedAt, input.affectedCount, input.significantRisk],
      );
      return rows[0]!.id;
    });
  }

  listIncidents(propertyId: string, filters: { status?: IncidentStatus; limit: number }): Promise<PrivacyListResult<PrivacyIncidentRecord>> {
    return this.list(
      "incident-list",
      `select ${INCIDENT_COLUMNS} from hoteles.privacy_incident where property_id = $1 and ($2::text is null or status = $2) order by detected_at desc, id limit $3;`,
      [propertyId, filters.status ?? null, filters.limit],
      toIncident,
    );
  }
  findIncident(propertyId: string, incidentId: string): Promise<PrivacyIncidentRecord | null> {
    return this.find("incident-find", `select ${INCIDENT_COLUMNS} from hoteles.privacy_incident where property_id = $1 and id = $2;`, [propertyId, incidentId], toIncident);
  }

  async updateIncident(incidentId: string, action: IncidentActionInput, actorUserId: string): Promise<IncidentStatus> {
    void actorUserId;
    return this.write("incident-update", "update_privacy_incident", async () => {
      const { rows } = await this.db.query<{ result: IncidentStatus }>(`select hoteles.update_privacy_incident($1, $2, $3, $4, $5) as result;`, [incidentId, action.action, action.note, action.channel, action.ref]);
      return rows[0]!.result;
    });
  }

  async placeLegalHold(input: NewLegalHoldInput, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("hold-place", "place_legal_hold", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select hoteles.place_legal_hold($1, $2, $3, $4, $5) as id;`, [input.vaultId, input.folio, input.reason, input.authorizationRef, input.incidentId]);
      return rows[0]!.id;
    });
  }

  listLegalHolds(propertyId: string, filters: { vaultId?: string; status?: LegalHoldStatus; limit: number }): Promise<PrivacyListResult<LegalHoldRecord>> {
    return this.list(
      "hold-list",
      `select ${HOLD_COLUMNS} from hoteles.legal_hold
       where property_id = $1 and ($2::uuid is null or vault_id = $2) and ($3::text is null or status = $3)
       order by placed_at desc, id limit $4;`,
      [propertyId, filters.vaultId ?? null, filters.status ?? null, filters.limit],
      toHold,
    );
  }
  findLegalHold(propertyId: string, holdId: string): Promise<LegalHoldRecord | null> {
    return this.find("hold-find", `select ${HOLD_COLUMNS} from hoteles.legal_hold where property_id = $1 and id = $2;`, [propertyId, holdId], toHold);
  }

  async releaseLegalHold(holdId: string, note: string, actorUserId: string): Promise<void> {
    void actorUserId;
    await this.write("hold-release", "release_legal_hold", async () => {
      await this.db.query(`select hoteles.release_legal_hold($1, $2);`, [holdId, note]);
    });
  }

  async blockIdentity(vaultId: string, reason: string, actorUserId: string): Promise<void> {
    void actorUserId;
    await this.write("identity-block", "block_identity", async () => {
      await this.db.query(`select hoteles.block_identity($1, $2);`, [vaultId, reason]);
    });
  }

  async requestBlockedAccess(vaultId: string, reason: string, actorUserId: string): Promise<string> {
    void actorUserId;
    return this.write("blocked-access-request", "request_blocked_access", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select hoteles.request_blocked_access($1, $2) as id;`, [vaultId, reason]);
      return rows[0]!.id;
    });
  }

  async decideBlockedAccess(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"aprobada" | "rechazada"> {
    void actorUserId;
    return this.write("blocked-access-decide", "decide_blocked_access", async () => {
      const { rows } = await this.db.query<{ result: "aprobada" | "rechazada" }>(`select hoteles.decide_blocked_access($1, $2, $3) as result;`, [requestId, approve, note]);
      return rows[0]!.result;
    });
  }

  listBlockedAccess(propertyId: string, filters: { status?: BlockedAccessStatus; limit: number }): Promise<PrivacyListResult<BlockedAccessRequestRecord>> {
    return this.list(
      "blocked-access-list",
      `select ${ACCESS_COLUMNS} from hoteles.identity_blocked_access_request where property_id = $1 and ($2::text is null or status = $2) order by created_at desc, id limit $3;`,
      [propertyId, filters.status ?? null, filters.limit],
      toAccess,
    );
  }
  findBlockedAccess(propertyId: string, requestId: string): Promise<BlockedAccessRequestRecord | null> {
    return this.find("blocked-access-find", `select ${ACCESS_COLUMNS} from hoteles.identity_blocked_access_request where property_id = $1 and id = $2;`, [propertyId, requestId], toAccess);
  }

  listEvents(propertyId: string, filters: { subjectType?: PrivacyEventSubject; subjectId?: string; limit: number }): Promise<PrivacyListResult<PrivacyEventRecord>> {
    return this.list(
      "event-list",
      `select ${EVENT_COLUMNS} from hoteles.privacy_event_log
       where property_id = $1 and ($2::text is null or subject_type = $2) and ($3::uuid is null or subject_id = $3)
       order by created_at desc, id limit $4;`,
      [propertyId, filters.subjectType ?? null, filters.subjectId ?? null, filters.limit],
      toEvent,
    );
  }
}
