// Adaptador Postgres de `PrivacidadRepository` (migracion 030). REGLA DURA de compatibilidad con la
// base SIN migrar: mergear despliega el codigo al instante y la 030 no se aplica sola. Toda
// consulta corre dentro de la transaccion UNICA de un request/webhook (`withAppSession`), donde un
// error de Postgres la deja abortada (25P02) y el COMMIT seria un ROLLBACK silencioso; por eso
// TODA operacion usa `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) antes de
// degradar a "no disponible".
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PRIVACY_CONFIG_POR_DEFECTO } from "./aviso.ts";
import type { PrivacyConfig, PrivacyConfigEntrada } from "./aviso.ts";
import type {
  ConfirmDataRightsOutcome,
  DataRightStaffTargetStatus,
  DataRightStatus,
  DataRightType,
  DataRightsChannel,
  DataRightsEventRow,
  DataRightsIdentityBasis,
  DataRightsPaginacion,
  DataRightsRequestRow,
  DataRightsRequestsFiltro,
  DataRightsRequestsPage,
  RegisterDataRightsOutcome,
  UpdateDataRightsStatusResult,
} from "./data-rights.ts";
import type { PrivacidadRepository, PurgeOutcome, RecordingConsent, SetRecordingConsentResult, UpdatePrivacyConfigResult } from "./repository.ts";

let advertido = false;
function advertirNoDisponible(operacion: string, err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    `PostgresPrivacidadRepository.${operacion}: los objetos de privacidad (restaurantes.data_rights_*, privacy_*) no existen todavia en esta base ` +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible'. Aplica packages/domain-restaurantes/migrations/030_privacidad_arco_aviso_retencion.sql " +
      "(o su espejo en supabase/migrations/) para habilitarlos.",
    err instanceof Error ? err.message : err,
  );
}

function sqlState(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

interface RequestRowSql {
  id: string;
  customer_phone: string;
  right_type: DataRightType;
  channel: DataRightsChannel;
  identity_basis: DataRightsIdentityBasis;
  status: DataRightStatus;
  detail: string | null;
  requested_at: string;
  confirmed_at: string | null;
  response_due_at: string | null;
  execution_due_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  handled_by: string | null;
  updated_at: string;
}

function mapRequestRow(row: RequestRowSql): DataRightsRequestRow {
  return {
    id: row.id,
    customerPhone: row.customer_phone,
    rightType: row.right_type,
    channel: row.channel,
    identityBasis: row.identity_basis,
    status: row.status,
    detail: row.detail,
    requestedAt: row.requested_at,
    confirmedAt: row.confirmed_at,
    responseDueAt: row.response_due_at,
    executionDueAt: row.execution_due_at,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    handledBy: row.handled_by,
    updatedAt: row.updated_at,
  };
}

export class PostgresPrivacidadRepository implements PrivacidadRepository {
  constructor(private readonly db: TenantDbSession) {}

  async getPrivacyConfig(organizationId: string): Promise<PrivacyConfig> {
    return runWithSavepointFallback<PrivacyConfig>({
      session: this.db,
      savepointName: "sp_privacy_config_get",
      primary: async () => {
        const { rows } = await this.db.query<{
          responsible_name: string | null;
          notice_url: string | null;
          notice_version: string;
          conversation_retention_days: number;
          voice_retention_days: number;
          recording_consent_required: boolean;
        }>(
          `select responsible_name, notice_url, notice_version, conversation_retention_days, voice_retention_days, recording_consent_required
             from restaurantes.privacy_config where organization_id = $1;`,
          [organizationId],
        );
        const row = rows[0];
        if (!row) return PRIVACY_CONFIG_POR_DEFECTO;
        return {
          responsibleName: row.responsible_name,
          noticeUrl: row.notice_url,
          noticeVersion: row.notice_version,
          conversationRetentionDays: Number(row.conversation_retention_days),
          voiceRetentionDays: Number(row.voice_retention_days),
          recordingConsentRequired: row.recording_consent_required,
          configurada: true,
        };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirNoDisponible("getPrivacyConfig", err);
        return Promise.resolve(PRIVACY_CONFIG_POR_DEFECTO);
      },
    });
  }

  async claimPrivacyNotice(organizationId: string, phoneHash: string, channel: DataRightsChannel, version: string): Promise<boolean | null> {
    return runWithSavepointFallback<boolean | null>({
      session: this.db,
      savepointName: "sp_privacy_notice_claim",
      primary: async () => {
        const { rows } = await this.db.query<{ claimed: boolean }>(`select restaurantes.system_claim_privacy_notice($1, $2, $3, $4) as claimed;`, [organizationId, phoneHash, channel, version]);
        return rows[0]?.claimed === true;
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.system_claim_privacy_notice"),
      fallback: (err) => {
        advertirNoDisponible("claimPrivacyNotice", err);
        return Promise.resolve(null);
      },
    });
  }

  async registerDataRightsRequestAsSystem(input: {
    readonly organizationId: string;
    readonly customerPhone: string;
    readonly rightType: DataRightType;
    readonly channel: DataRightsChannel;
    readonly detail: string | null;
  }): Promise<RegisterDataRightsOutcome> {
    return runWithSavepointFallback<RegisterDataRightsOutcome>({
      session: this.db,
      savepointName: "sp_privacy_arco_register",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_status: DataRightStatus; out_already_open: boolean; out_response_due_at: string | null }>(
          `select out_id, out_status, out_already_open, out_response_due_at::text as out_response_due_at from restaurantes.system_register_data_rights_request($1, $2, $3, $4, $5);`,
          [input.organizationId, input.customerPhone, input.rightType, input.channel, input.detail],
        );
        const row = rows[0];
        if (!row) return { available: false };
        return { available: true, id: row.out_id, status: row.out_status, alreadyOpen: row.out_already_open, responseDueAt: row.out_response_due_at };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.system_register_data_rights_request"),
      fallback: (err) => {
        advertirNoDisponible("registerDataRightsRequestAsSystem", err);
        return Promise.resolve({ available: false });
      },
    });
  }

  async resolveDataRightsConfirmationAsSystem(organizationId: string, customerPhone: string, confirm: boolean): Promise<ConfirmDataRightsOutcome> {
    return runWithSavepointFallback<ConfirmDataRightsOutcome>({
      session: this.db,
      savepointName: "sp_privacy_arco_confirm",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_right_type: DataRightType; out_status: DataRightStatus; out_response_due_at: string | null; out_execution_due_at: string | null }>(
          `select out_id, out_right_type, out_status, out_response_due_at::text as out_response_due_at, out_execution_due_at::text as out_execution_due_at from restaurantes.system_resolve_data_rights_confirmation($1, $2, $3);`,
          [organizationId, customerPhone, confirm],
        );
        const row = rows[0];
        if (!row) return { available: true, found: false };
        return { available: true, found: true, id: row.out_id, rightType: row.out_right_type, status: row.out_status, responseDueAt: row.out_response_due_at, executionDueAt: row.out_execution_due_at };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.system_resolve_data_rights_confirmation"),
      fallback: (err) => {
        advertirNoDisponible("resolveDataRightsConfirmationAsSystem", err);
        return Promise.resolve({ available: false });
      },
    });
  }

  async setVoiceRecordingConsent(organizationId: string, conversationId: string, consent: RecordingConsent): Promise<SetRecordingConsentResult> {
    return runWithSavepointFallback<SetRecordingConsentResult>({
      session: this.db,
      savepointName: "sp_privacy_voice_consent",
      primary: async () => {
        const { rows } = await this.db.query<{ result: RecordingConsent }>(`select restaurantes.system_set_voice_recording_consent($1, $2, $3) as result;`, [organizationId, conversationId, consent === "otorgado"]);
        const result = rows[0]?.result;
        return result ? { outcome: "set", consent: result } : { outcome: "rejected" };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.system_set_voice_recording_consent") || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve({ outcome: "rejected" });
        advertirNoDisponible("setVoiceRecordingConsent", err);
        return Promise.resolve({ outcome: "unavailable" });
      },
    });
  }

  async purgeExpiredPrivacyData(limit: number): Promise<PurgeOutcome> {
    return runWithSavepointFallback<PurgeOutcome>({
      session: this.db,
      savepointName: "sp_privacy_purge",
      primary: async () => {
        // `select *`: contra la base con la 030 pero sin la 046 la funcion solo trae 3 columnas; las nuevas llegan como undefined.
        const { rows } = await this.db.query<{
          out_conversations_cleared: number;
          out_voice_turns_deleted: number;
          out_voice_calls_anonymized: number;
          out_orders_voice_cleared?: number;
          out_outbox_payloads_erased?: number;
          out_staff_notifications_erased?: number;
        }>(`select * from restaurantes.system_purge_expired_privacy_data($1);`, [limit]);
        const row = rows[0];
        return {
          disponible: true,
          conversationsCleared: Number(row?.out_conversations_cleared ?? 0),
          voiceTurnsDeleted: Number(row?.out_voice_turns_deleted ?? 0),
          voiceCallsAnonymized: Number(row?.out_voice_calls_anonymized ?? 0),
          ordersVoiceCleared: Number(row?.out_orders_voice_cleared ?? 0),
          outboxPayloadsErased: Number(row?.out_outbox_payloads_erased ?? 0),
          staffNotificationsErased: Number(row?.out_staff_notifications_erased ?? 0),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.system_purge_expired_privacy_data"),
      fallback: (err) => {
        advertirNoDisponible("purgeExpiredPrivacyData", err);
        return Promise.resolve({ disponible: false, conversationsCleared: 0, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 });
      },
    });
  }

  async listDataRightsRequests(organizationId: string, filtro: DataRightsRequestsFiltro, paginacion: DataRightsPaginacion): Promise<DataRightsRequestsPage> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);
    const params: unknown[] = [organizationId];
    const condiciones = ["organization_id = $1"];
    if (filtro.status) {
      params.push(filtro.status);
      condiciones.push(`status = $${params.length}`);
    }
    if (filtro.rightType) {
      params.push(filtro.rightType);
      condiciones.push(`right_type = $${params.length}`);
    }
    const where = condiciones.join(" and ");

    return runWithSavepointFallback<DataRightsRequestsPage>({
      session: this.db,
      savepointName: "sp_privacy_arco_list",
      primary: async () => {
        const totalResult = await this.db.query<{ total: string }>(`select count(*)::text as total from restaurantes.data_rights_requests where ${where};`, params);
        const total = Number(totalResult.rows[0]?.total ?? 0);
        const pageParams = [...params, limit, offset];
        const { rows } = await this.db.query<RequestRowSql>(
          `select id, customer_phone, right_type, channel, identity_basis, status, detail, requested_at::text as requested_at, confirmed_at::text as confirmed_at,
                  response_due_at::text as response_due_at, execution_due_at::text as execution_due_at, resolved_at::text as resolved_at,
                  resolution_note, handled_by, updated_at::text as updated_at
             from restaurantes.data_rights_requests where ${where} order by created_at desc, seq desc limit $${pageParams.length - 1} offset $${pageParams.length};`,
          pageParams,
        );
        const items = rows.map(mapRequestRow);
        return { disponible: true, items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirNoDisponible("listDataRightsRequests", err);
        return Promise.resolve({ disponible: false, items: [], total: 0, nextOffset: null });
      },
    });
  }

  async listDataRightsEvents(organizationId: string, requestId: string): Promise<readonly DataRightsEventRow[] | null> {
    return runWithSavepointFallback<readonly DataRightsEventRow[] | null>({
      session: this.db,
      savepointName: "sp_privacy_arco_events",
      primary: async () => {
        const { rows } = await this.db.query<{
          id: string;
          request_id: string;
          actor_kind: "titular" | "sistema" | "staff";
          actor_user_id: string | null;
          event: string;
          from_status: string | null;
          to_status: string | null;
          note: string | null;
          created_at: string;
        }>(
          `select id, request_id, actor_kind, actor_user_id, event, from_status, to_status, note, created_at::text as created_at
             from restaurantes.data_rights_events where organization_id = $1 and request_id = $2 order by created_at asc, seq asc;`,
          [organizationId, requestId],
        );
        return rows.map((r) => ({
          id: r.id,
          requestId: r.request_id,
          actorKind: r.actor_kind,
          actorUserId: r.actor_user_id,
          event: r.event,
          fromStatus: r.from_status,
          toStatus: r.to_status,
          note: r.note,
          createdAt: r.created_at,
        }));
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirNoDisponible("listDataRightsEvents", err);
        return Promise.resolve(null);
      },
    });
  }

  async updateDataRightsRequestStatus(organizationId: string, requestId: string, status: DataRightStaffTargetStatus, note: string | null): Promise<UpdateDataRightsStatusResult> {
    return runWithSavepointFallback<UpdateDataRightsStatusResult>({
      session: this.db,
      savepointName: "sp_privacy_arco_update",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_status: DataRightStatus }>(
          `select out_id, out_status from restaurantes.update_data_rights_request_status($1, $2, $3, $4);`,
          [organizationId, requestId, status, note],
        );
        const row = rows[0];
        if (!row) return { outcome: "not_found" };
        return { outcome: "updated", id: row.out_id, status: row.out_status };
      },
      // La base sin migrar (42883/42P01/42703) Y los errores de negocio de la propia funcion SQL
      // (P0002 no existe, 55000 transicion invalida, 22023 parametro, 42501 sin rol) son
      // recuperables: todos se resuelven DENTRO del SAVEPOINT.
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.update_data_rights_request_status") || ["P0002", "55000", "22023", "42501"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        switch (sqlState(err)) {
          case "P0002":
            return Promise.resolve({ outcome: "not_found" });
          case "55000":
            return Promise.resolve({ outcome: "invalid_transition" });
          case "22023":
            return Promise.resolve({ outcome: "invalid_input" });
          case "42501":
            return Promise.resolve({ outcome: "forbidden" });
          default:
            advertirNoDisponible("updateDataRightsRequestStatus", err);
            return Promise.resolve({ outcome: "unavailable" });
        }
      },
    });
  }

  async updatePrivacyConfig(organizationId: string, config: PrivacyConfigEntrada): Promise<UpdatePrivacyConfigResult> {
    return runWithSavepointFallback<UpdatePrivacyConfigResult>({
      session: this.db,
      savepointName: "sp_privacy_config_update",
      primary: async () => {
        await this.db.query(`select out_organization_id from restaurantes.update_privacy_config($1, $2, $3, $4, $5, $6, $7);`, [
          organizationId,
          config.responsibleName,
          config.noticeUrl,
          config.noticeVersion,
          config.conversationRetentionDays,
          config.voiceRetentionDays,
          config.recordingConsentRequired,
        ]);
        return { outcome: "updated" };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "restaurantes.update_privacy_config") || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve({ outcome: "forbidden" });
        advertirNoDisponible("updatePrivacyConfig", err);
        return Promise.resolve({ outcome: "unavailable" });
      },
    });
  }
}
