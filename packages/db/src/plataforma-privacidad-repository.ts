// Repositorio de la privacidad de plataforma (PL-13 P1): solicitudes ARCO unificadas, retencion por
// organizacion, bloqueo y registro de purgas y aviso de privacidad versionado -- puerto contra las
// funciones `security definer` de packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql.
//
// SESIONES: esta clase no elige la sesion, recibe el `TenantDbSession` ya abierto. Los metodos `org*`
// y `platform*` corren con la sesion del usuario (el SQL valida owner/admin o superadmin con
// auth.uid()); `runRetentionPurge` SOLO con una sesion de sistema (`userId: null`).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un SQLSTATE
// 42883/42P01/42703 (0036 sin aplicar) revierte SOLO el savepoint y devuelve `availability:
// "not_migrated"`; nunca un 500 ni un exito simulado. Los errores de negocio del SQL (42501, 22023,
// 23514, 23505) se tipan como `PlataformaPrivacidadError`.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type PrivacidadAvailability = "available" | "not_migrated";

export type ArcoStatusBucket = "por_confirmar" | "abierta" | "en_proceso" | "bloqueada" | "resuelta" | "rechazada" | "cerrada";
export type PurgeStatus = "ok" | "simulacion" | "bloqueada" | "sin_ejecutor";
export type RetentionSource = "organizacion" | "vertical" | "defecto";

/** Solicitud ARCO normalizada. NUNCA lleva telefono, correo ni nombre del titular. */
export interface ArcoRequestRow {
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly vertical: string;
  readonly requestId: string;
  readonly rightType: string;
  readonly channel: string;
  readonly nativeStatus: string;
  readonly statusBucket: ArcoStatusBucket;
  readonly openedAtMs: number;
  readonly responseDueAtMs: number | null;
  readonly executionDueAtMs: number | null;
  /** Plazo relevante segun el estado: respuesta si no se ha atendido; ejecucion si esta en proceso. */
  readonly dueAtMs: number | null;
  readonly resolvedAtMs: number | null;
  readonly isOpen: boolean;
  readonly isOverdue: boolean;
}

export interface ArcoPage {
  readonly availability: PrivacidadAvailability;
  readonly total: number;
  readonly items: readonly ArcoRequestRow[];
}

export interface RetentionPolicyRow {
  readonly dataClass: string;
  readonly vertical: string;
  readonly description: string;
  readonly executor: "plataforma" | "vertical";
  readonly defaultDays: number;
  readonly minDays: number;
  readonly maxDays: number;
  readonly effectiveDays: number;
  readonly source: RetentionSource;
  readonly updatedAtMs: number | null;
}

export interface PurgeHoldRow {
  readonly id: string;
  readonly dataClass: string | null;
  readonly reason: string;
  readonly placedAtMs: number;
  readonly releasedAtMs: number | null;
  readonly releaseNote: string | null;
  readonly active: boolean;
}

export interface PurgeRunRow {
  readonly seq: number;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly dataClass: string;
  readonly status: PurgeStatus;
  readonly retentionDays: number | null;
  readonly cutoffAtMs: number | null;
  readonly rowsAffected: number;
  readonly rowsAnonymized: number;
  readonly rowsProtected: number;
  readonly blockedReason: string | null;
  readonly createdAtMs: number;
}

export interface PrivacyNoticeRow {
  readonly noticeId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly noticeUrl: string;
  readonly contentSha256: string;
  readonly createdAtMs: number;
  readonly acceptedCount: number;
  readonly acceptedByCaller: boolean;
  readonly isCurrent: boolean;
}

export interface PrivacyOverviewRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly openArco: number;
  readonly overdueArco: number;
  readonly noticeVersion: number | null;
  readonly noticeAcceptances: number;
  readonly activeHolds: number;
  readonly lastPurgeAtMs: number | null;
  readonly lastPurgeStatus: PurgeStatus | null;
}

export interface PurgeRunResult {
  readonly runId: string;
  readonly status: PurgeStatus;
  readonly retentionDays: number;
  readonly rowsAffected: number;
  readonly rowsAnonymized: number;
  readonly rowsProtected: number;
}

export type PlataformaPrivacidadErrorKind = "forbidden" | "invalid" | "conflict";

export class PlataformaPrivacidadError extends Error {
  constructor(
    message: string,
    readonly code: PlataformaPrivacidadErrorKind,
  ) {
    super(message);
    this.name = "PlataformaPrivacidadError";
  }
}

export interface ArcoQuery {
  readonly onlyOpen: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface PlataformaPrivacidadRepository {
  /** STAFF owner/admin (el SQL devuelve cero filas a cualquier otro). */
  orgListArco(orgId: string, query: ArcoQuery): Promise<ArcoPage>;
  orgListRetention(orgId: string): Promise<{ availability: PrivacidadAvailability; items: readonly RetentionPolicyRow[] }>;
  orgSetRetention(orgId: string, dataClass: string, days: number): Promise<{ availability: PrivacidadAvailability }>;
  orgClearRetention(orgId: string, dataClass: string): Promise<{ availability: PrivacidadAvailability; cleared: boolean }>;
  orgListHolds(orgId: string): Promise<{ availability: PrivacidadAvailability; items: readonly PurgeHoldRow[] }>;
  orgPlaceHold(orgId: string, dataClass: string | null, reason: string): Promise<{ availability: PrivacidadAvailability; id: string | null }>;
  orgReleaseHold(orgId: string, holdId: string, note: string | null): Promise<{ availability: PrivacidadAvailability; released: boolean }>;
  orgListPurgeRuns(orgId: string, limit: number, beforeSeq: number | null): Promise<{ availability: PrivacidadAvailability; items: readonly PurgeRunRow[] }>;
  orgListNotices(orgId: string, limit: number): Promise<{ availability: PrivacidadAvailability; items: readonly PrivacyNoticeRow[] }>;
  orgPublishNotice(orgId: string, title: string, summary: string, url: string): Promise<{ availability: PrivacidadAvailability; noticeId: string | null; version: number | null }>;
  orgAcceptNotice(orgId: string, version: number): Promise<{ availability: PrivacidadAvailability; accepted: boolean }>;
  /** SUPERADMIN (solo lectura; el SQL devuelve cero filas a quien no lo sea o este restringido). */
  platformListArco(callerId: string, query: ArcoQuery & { readonly onlyOverdue: boolean }): Promise<ArcoPage>;
  platformOverview(callerId: string, limit: number, offset: number): Promise<{ availability: PrivacidadAvailability; total: number; items: readonly PrivacyOverviewRow[] }>;
  platformListPurgeRuns(callerId: string, limit: number, beforeSeq: number | null): Promise<{ availability: PrivacidadAvailability; items: readonly PurgeRunRow[] }>;
  /** SOLO SISTEMA (`withAppSession({ userId: null })`). Una organizacion y una clase por llamada. */
  runRetentionPurge(orgId: string, dataClass: string, dryRun: boolean, limit: number): Promise<{ availability: PrivacidadAvailability; result: PurgeRunResult | null }>;
  /** SOLO SISTEMA. Pares (organizacion, clase) que la plataforma purga, por paginas de organizaciones (cursor = ultimo id). */
  listPurgeTargets(afterOrgId: string | null, orgLimit: number, onlyOrgId?: string | null): Promise<{ availability: PrivacidadAvailability; targets: readonly PurgeTarget[] }>;
}

export interface PurgeTarget {
  readonly organizationId: string;
  readonly dataClass: string;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "plataforma-privacidad-repository: las funciones/tablas de 0036_plataforma_arco_retencion_aviso.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'privacidad de plataforma no disponible' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar la vista ARCO, la retencion, el registro de purgas y el aviso versionado.",
  );
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function toTypedError(err: unknown): PlataformaPrivacidadError | null {
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case "42501":
      return new PlataformaPrivacidadError(message, "forbidden");
    case "22023":
    case "23514":
    case "22P02":
      return new PlataformaPrivacidadError(message, "invalid");
    case "23505":
      return new PlataformaPrivacidadError(message, "conflict");
    default:
      return null;
  }
}

async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

/**
 * Clases de dato de plataforma cuyo ejecutor es una funcion del propio vertical (no una rama de core.system_run_retention_purge, que otros
 * cambios reescriben): clase -> funcion SQL de solo sistema con la firma (organizacion, simulacion, limite). Mapa fijo del repositorio.
 */
const EJECUTORES_DE_VERTICAL: Readonly<Record<string, string>> = {
  hoteles_whatsapp_conversaciones: "hoteles.system_run_retention_conversaciones",
};

type Ts = string | Date;
const ms = (v: Ts): number => new Date(v).getTime();
const msOrNull = (v: Ts | null): number | null => (v === null || v === undefined ? null : new Date(v).getTime());

interface ArcoDbRow {
  out_organization_id?: string;
  out_organization_name?: string;
  out_vertical: string;
  out_request_id: string;
  out_right_type: string;
  out_channel: string;
  out_native_status: string;
  out_status_bucket: ArcoStatusBucket;
  out_opened_at: Ts;
  out_response_due_at: Ts | null;
  out_execution_due_at: Ts | null;
  out_due_at: Ts | null;
  out_resolved_at: Ts | null;
  out_is_open: boolean;
  out_is_overdue: boolean;
  out_total: string | number;
}

const mapArco = (r: ArcoDbRow): ArcoRequestRow => ({
  organizationId: r.out_organization_id ?? null,
  organizationName: r.out_organization_name ?? null,
  vertical: r.out_vertical,
  requestId: r.out_request_id,
  rightType: r.out_right_type,
  channel: r.out_channel,
  nativeStatus: r.out_native_status,
  statusBucket: r.out_status_bucket,
  openedAtMs: ms(r.out_opened_at),
  responseDueAtMs: msOrNull(r.out_response_due_at),
  executionDueAtMs: msOrNull(r.out_execution_due_at),
  dueAtMs: msOrNull(r.out_due_at),
  resolvedAtMs: msOrNull(r.out_resolved_at),
  isOpen: r.out_is_open,
  isOverdue: r.out_is_overdue,
});

interface PurgeRunDbRow {
  out_seq: string | number;
  out_organization_id?: string;
  out_organization_name?: string;
  out_data_class: string;
  out_status: PurgeStatus;
  out_retention_days: number | null;
  out_cutoff_at: Ts | null;
  out_rows_affected: number;
  out_rows_anonymized: number;
  out_rows_protected: number;
  out_blocked_reason: string | null;
  out_created_at: Ts;
}

const mapPurgeRun = (r: PurgeRunDbRow): PurgeRunRow => ({
  seq: Number(r.out_seq),
  organizationId: r.out_organization_id ?? null,
  organizationName: r.out_organization_name ?? null,
  dataClass: r.out_data_class,
  status: r.out_status,
  retentionDays: r.out_retention_days,
  cutoffAtMs: msOrNull(r.out_cutoff_at),
  rowsAffected: r.out_rows_affected,
  rowsAnonymized: r.out_rows_anonymized,
  rowsProtected: r.out_rows_protected,
  blockedReason: r.out_blocked_reason,
  createdAtMs: ms(r.out_created_at),
});

const NOT_MIGRATED_ARCO: ArcoPage = { availability: "not_migrated", total: 0, items: [] };

export class PostgresPlataformaPrivacidadRepository implements PlataformaPrivacidadRepository {
  constructor(private readonly db: TenantDbSession) {}

  orgListArco(orgId: string, query: ArcoQuery) {
    return guarded(
      this.db,
      async (): Promise<ArcoPage> => {
        const { rows } = await this.db.query<ArcoDbRow>(`select * from core.org_list_arco_requests($1, $2, $3::int, $4::int);`, [orgId, query.onlyOpen, query.limit, query.offset]);
        return { availability: "available", total: rows[0] ? Number(rows[0].out_total) : 0, items: rows.map(mapArco) };
      },
      () => NOT_MIGRATED_ARCO,
    );
  }

  orgListRetention(orgId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          out_data_class: string;
          out_vertical: string;
          out_description: string;
          out_executor: "plataforma" | "vertical";
          out_default_days: number;
          out_min_days: number;
          out_max_days: number;
          out_effective_days: number;
          out_source: RetentionSource;
          out_updated_at: Ts | null;
        }>(`select * from core.org_list_retention_policies($1);`, [orgId]);
        return {
          availability: "available" as const,
          items: rows.map(
            (r): RetentionPolicyRow => ({
              dataClass: r.out_data_class,
              vertical: r.out_vertical,
              description: r.out_description,
              executor: r.out_executor,
              defaultDays: r.out_default_days,
              minDays: r.out_min_days,
              maxDays: r.out_max_days,
              effectiveDays: r.out_effective_days,
              source: r.out_source,
              updatedAtMs: msOrNull(r.out_updated_at),
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, items: [] as readonly RetentionPolicyRow[] }),
    );
  }

  orgSetRetention(orgId: string, dataClass: string, days: number) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.org_set_retention_policy($1, $2, $3::int);`, [orgId, dataClass, days]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  orgClearRetention(orgId: string, dataClass: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ cleared: boolean }>(`select core.org_clear_retention_policy($1, $2) as cleared;`, [orgId, dataClass]);
        return { availability: "available" as const, cleared: rows[0]?.cleared === true };
      },
      () => ({ availability: "not_migrated" as const, cleared: false }),
    );
  }

  orgListHolds(orgId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          out_id: string;
          out_data_class: string | null;
          out_reason: string;
          out_placed_at: Ts;
          out_released_at: Ts | null;
          out_release_note: string | null;
          out_active: boolean;
        }>(`select * from core.org_list_purge_holds($1);`, [orgId]);
        return {
          availability: "available" as const,
          items: rows.map(
            (r): PurgeHoldRow => ({ id: r.out_id, dataClass: r.out_data_class, reason: r.out_reason, placedAtMs: ms(r.out_placed_at), releasedAtMs: msOrNull(r.out_released_at), releaseNote: r.out_release_note, active: r.out_active }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, items: [] as readonly PurgeHoldRow[] }),
    );
  }

  orgPlaceHold(orgId: string, dataClass: string | null, reason: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ id: string }>(`select core.org_place_purge_hold($1, $2, $3) as id;`, [orgId, dataClass, reason]);
        return { availability: "available" as const, id: rows[0]?.id ?? null };
      },
      () => ({ availability: "not_migrated" as const, id: null as string | null }),
    );
  }

  orgReleaseHold(orgId: string, holdId: string, note: string | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ released: boolean }>(`select core.org_release_purge_hold($1, $2, $3) as released;`, [orgId, holdId, note]);
        return { availability: "available" as const, released: rows[0]?.released === true };
      },
      () => ({ availability: "not_migrated" as const, released: false }),
    );
  }

  orgListPurgeRuns(orgId: string, limit: number, beforeSeq: number | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<PurgeRunDbRow>(`select * from core.org_list_purge_runs($1, $2::int, $3::bigint);`, [orgId, limit, beforeSeq]);
        return { availability: "available" as const, items: rows.map(mapPurgeRun) };
      },
      () => ({ availability: "not_migrated" as const, items: [] as readonly PurgeRunRow[] }),
    );
  }

  orgListNotices(orgId: string, limit: number) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          out_notice_id: string;
          out_version: number;
          out_title: string;
          out_summary: string;
          out_notice_url: string;
          out_content_sha256: string;
          out_created_at: Ts;
          out_accepted_count: string | number;
          out_accepted_by_caller: boolean;
          out_is_current: boolean;
        }>(`select * from core.org_list_privacy_notices($1, $2::int);`, [orgId, limit]);
        return {
          availability: "available" as const,
          items: rows.map(
            (r): PrivacyNoticeRow => ({
              noticeId: r.out_notice_id,
              version: r.out_version,
              title: r.out_title,
              summary: r.out_summary,
              noticeUrl: r.out_notice_url,
              contentSha256: r.out_content_sha256,
              createdAtMs: ms(r.out_created_at),
              acceptedCount: Number(r.out_accepted_count),
              acceptedByCaller: r.out_accepted_by_caller,
              isCurrent: r.out_is_current,
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, items: [] as readonly PrivacyNoticeRow[] }),
    );
  }

  orgPublishNotice(orgId: string, title: string, summary: string, url: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ out_notice_id: string; out_version: number }>(`select * from core.org_publish_privacy_notice($1, $2, $3, $4);`, [orgId, title, summary, url]);
        return { availability: "available" as const, noticeId: rows[0]?.out_notice_id ?? null, version: rows[0]?.out_version ?? null };
      },
      () => ({ availability: "not_migrated" as const, noticeId: null as string | null, version: null as number | null }),
    );
  }

  orgAcceptNotice(orgId: string, version: number) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ accepted: boolean }>(`select core.org_accept_privacy_notice($1, $2::int) as accepted;`, [orgId, version]);
        return { availability: "available" as const, accepted: rows[0]?.accepted === true };
      },
      () => ({ availability: "not_migrated" as const, accepted: false }),
    );
  }

  platformListArco(callerId: string, query: ArcoQuery & { readonly onlyOverdue: boolean }) {
    return guarded(
      this.db,
      async (): Promise<ArcoPage> => {
        const { rows } = await this.db.query<ArcoDbRow>(`select * from core.platform_list_arco_requests($1, $2, $3, $4::int, $5::int);`, [callerId, query.onlyOpen, query.onlyOverdue, query.limit, query.offset]);
        return { availability: "available", total: rows[0] ? Number(rows[0].out_total) : 0, items: rows.map(mapArco) };
      },
      () => NOT_MIGRATED_ARCO,
    );
  }

  platformOverview(callerId: string, limit: number, offset: number) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          out_organization_id: string;
          out_organization_name: string;
          out_vertical: string;
          out_open_arco: string | number;
          out_overdue_arco: string | number;
          out_notice_version: number | null;
          out_notice_acceptances: string | number;
          out_active_holds: string | number;
          out_last_purge_at: Ts | null;
          out_last_purge_status: PurgeStatus | null;
          out_total: string | number;
        }>(`select * from core.platform_privacy_overview($1, $2::int, $3::int);`, [callerId, limit, offset]);
        return {
          availability: "available" as const,
          total: rows[0] ? Number(rows[0].out_total) : 0,
          items: rows.map(
            (r): PrivacyOverviewRow => ({
              organizationId: r.out_organization_id,
              organizationName: r.out_organization_name,
              vertical: r.out_vertical,
              openArco: Number(r.out_open_arco),
              overdueArco: Number(r.out_overdue_arco),
              noticeVersion: r.out_notice_version,
              noticeAcceptances: Number(r.out_notice_acceptances),
              activeHolds: Number(r.out_active_holds),
              lastPurgeAtMs: msOrNull(r.out_last_purge_at),
              lastPurgeStatus: r.out_last_purge_status,
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, total: 0, items: [] as readonly PrivacyOverviewRow[] }),
    );
  }

  platformListPurgeRuns(callerId: string, limit: number, beforeSeq: number | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<PurgeRunDbRow>(`select * from core.platform_list_purge_runs($1, $2::int, $3::bigint);`, [callerId, limit, beforeSeq]);
        return { availability: "available" as const, items: rows.map(mapPurgeRun) };
      },
      () => ({ availability: "not_migrated" as const, items: [] as readonly PurgeRunRow[] }),
    );
  }

  runRetentionPurge(orgId: string, dataClass: string, dryRun: boolean, limit: number) {
    return guarded(
      this.db,
      async () => {
        // H-P3-03: las clases de plataforma cuyo ejecutor vive en el propio vertical se enrutan a su funcion (mapa fijo, nunca texto del
        // llamador); las demas siguen en core.system_run_retention_purge. Mismas columnas de salida, mismo bloqueo legal y mismo registro.
        const ejecutorDeVertical = EJECUTORES_DE_VERTICAL[dataClass];
        const consulta = ejecutorDeVertical
          ? { sql: `select * from ${ejecutorDeVertical}($1, $2::boolean, $3::int);`, params: [orgId, dryRun, limit] as unknown[] }
          : { sql: `select * from core.system_run_retention_purge($1, $2, $3, $4::int);`, params: [orgId, dataClass, dryRun, limit] as unknown[] };
        const { rows } = await this.db.query<{
          out_run_id: string;
          out_status: PurgeStatus;
          out_retention_days: number;
          out_rows_affected: number;
          out_rows_anonymized: number;
          out_rows_protected: number;
        }>(consulta.sql, consulta.params);
        const r = rows[0];
        return {
          availability: "available" as const,
          result: r ? ({ runId: r.out_run_id, status: r.out_status, retentionDays: r.out_retention_days, rowsAffected: r.out_rows_affected, rowsAnonymized: r.out_rows_anonymized, rowsProtected: r.out_rows_protected } satisfies PurgeRunResult) : null,
        };
      },
      () => ({ availability: "not_migrated" as const, result: null as PurgeRunResult | null }),
    );
  }
  listPurgeTargets(afterOrgId: string | null, orgLimit: number, onlyOrgId: string | null = null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ out_organization_id: string; out_data_class: string }>(`select * from core.system_list_purge_targets($1, $2::int, $3);`, [afterOrgId, orgLimit, onlyOrgId]);
        return { availability: "available" as const, targets: rows.map((r): PurgeTarget => ({ organizationId: r.out_organization_id, dataClass: r.out_data_class })) };
      },
      () => ({ availability: "not_migrated" as const, targets: [] as readonly PurgeTarget[] }),
    );
  }
}

/**
 * Adaptador en memoria para los tests de rutas. Misma semantica de ACCESO que el SQL (solo
 * owner/admin de la organizacion; solo superadmin para lo de plataforma; cero filas para el resto) y
 * mismas validaciones de rango; NO simula el borrado real (eso lo prueba scripts/verify-plataforma-privacidad).
 */
export class InMemoryPlataformaPrivacidadRepository implements PlataformaPrivacidadRepository {
  private readonly admins = new Set<string>();
  private readonly superadmins = new Set<string>();
  private readonly arco: Array<ArcoRequestRow & { readonly orgId: string }> = [];
  private readonly policies = new Map<string, number>();
  private readonly holds: Array<PurgeHoldRow & { readonly orgId: string }> = [];
  private readonly runs: Array<PurgeRunRow & { readonly orgId: string }> = [];
  private readonly notices: Array<PrivacyNoticeRow & { readonly orgId: string; readonly acceptors: Set<string> }> = [];
  private holdSeq = 0;
  private runSeq = 0;
  /** Quien llama (para `acceptedByCaller` y los autores); se fija con `as()`. */
  private actor = "";
  readonly classes: readonly Omit<RetentionPolicyRow, "effectiveDays" | "source" | "updatedAtMs">[] = [
    { dataClass: "restaurantes_whatsapp_conversaciones", vertical: "restaurantes", description: "Mensajes de conversaciones de WhatsApp de comensales.", executor: "plataforma", defaultDays: 180, minDays: 30, maxDays: 1095 },
    { dataClass: "restaurantes_voz_transcripciones", vertical: "restaurantes", description: "Transcripciones de llamadas de voz.", executor: "plataforma", defaultDays: 30, minDays: 0, maxDays: 365 },
    { dataClass: "hoteles_identidad_documento", vertical: "hoteles", description: "Documento de identidad del huesped.", executor: "vertical", defaultDays: 30, minDays: 0, maxDays: 365 },
  ];

  constructor(private readonly opciones: { readonly migrado?: boolean; readonly now?: () => number } = {}) {}

  seedOrgAdmin(orgId: string, userId: string): void {
    this.admins.add(`${orgId}:${userId}`);
  }
  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedArco(orgId: string, row: Omit<ArcoRequestRow, "organizationId" | "organizationName">, organizationName = orgId): void {
    this.arco.push({ ...row, organizationId: orgId, organizationName, orgId });
  }
  /** Fija el usuario de la siguiente llamada (el SQL real lo toma de auth.uid()). */
  as(userId: string): this {
    this.actor = userId;
    return this;
  }
  purgeRuns(): readonly PurgeRunRow[] {
    return [...this.runs];
  }

  private get migrado(): boolean {
    return this.opciones.migrado ?? true;
  }
  private now(): number {
    return this.opciones.now ? this.opciones.now() : Date.now();
  }
  private isAdmin(orgId: string): boolean {
    return this.admins.has(`${orgId}:${this.actor}`);
  }
  private requireAdmin(orgId: string, fn: string): void {
    if (!this.isAdmin(orgId)) throw new PlataformaPrivacidadError(`${fn}: solo owner/admin de la organizacion`, "forbidden");
  }
  private isReader(callerId: string): boolean {
    return this.superadmins.has(callerId) && callerId === this.actor;
  }
  private classOf(dataClass: string) {
    return this.classes.find((c) => c.dataClass === dataClass);
  }

  async orgListArco(orgId: string, query: ArcoQuery): Promise<ArcoPage> {
    if (!this.migrado) return NOT_MIGRATED_ARCO;
    if (!this.isAdmin(orgId)) return { availability: "available", total: 0, items: [] };
    const all = this.arco.filter((r) => r.orgId === orgId && (!query.onlyOpen || r.isOpen));
    return { availability: "available", total: all.length, items: all.slice(query.offset, query.offset + query.limit).map(({ orgId: _o, organizationId: _i, organizationName: _n, ...r }) => ({ ...r, organizationId: null, organizationName: null })) };
  }

  async orgListRetention(orgId: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, items: [] as readonly RetentionPolicyRow[] };
    if (!this.isAdmin(orgId)) return { availability: "available" as const, items: [] as readonly RetentionPolicyRow[] };
    return {
      availability: "available" as const,
      items: this.classes.map((c): RetentionPolicyRow => {
        const own = this.policies.get(`${orgId}:${c.dataClass}`);
        return { ...c, effectiveDays: own ?? c.defaultDays, source: own === undefined ? "defecto" : "organizacion", updatedAtMs: own === undefined ? null : this.now() };
      }),
    };
  }

  async orgSetRetention(orgId: string, dataClass: string, days: number) {
    if (!this.migrado) return { availability: "not_migrated" as const };
    this.requireAdmin(orgId, "org_set_retention_policy");
    const c = this.classOf(dataClass);
    if (!c) throw new PlataformaPrivacidadError("org_set_retention_policy: clase de dato desconocida", "invalid");
    if (c.executor !== "plataforma") throw new PlataformaPrivacidadError("org_set_retention_policy: la retencion de esta clase la gobierna el vertical", "invalid");
    if (!Number.isInteger(days) || days < c.minDays || days > c.maxDays) throw new PlataformaPrivacidadError(`org_set_retention_policy: los dias deben estar entre ${c.minDays} y ${c.maxDays}`, "invalid");
    this.policies.set(`${orgId}:${dataClass}`, days);
    return { availability: "available" as const };
  }

  async orgClearRetention(orgId: string, dataClass: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, cleared: false };
    this.requireAdmin(orgId, "org_clear_retention_policy");
    return { availability: "available" as const, cleared: this.policies.delete(`${orgId}:${dataClass}`) };
  }

  async orgListHolds(orgId: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, items: [] as readonly PurgeHoldRow[] };
    if (!this.isAdmin(orgId)) return { availability: "available" as const, items: [] as readonly PurgeHoldRow[] };
    return { availability: "available" as const, items: this.holds.filter((h) => h.orgId === orgId).map(({ orgId: _o, ...h }) => h) };
  }

  async orgPlaceHold(orgId: string, dataClass: string | null, reason: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, id: null as string | null };
    this.requireAdmin(orgId, "org_place_purge_hold");
    if (dataClass !== null && !this.classOf(dataClass)) throw new PlataformaPrivacidadError("org_place_purge_hold: clase de dato desconocida", "invalid");
    const r = reason.trim();
    if (r.length < 10 || r.length > 300) throw new PlataformaPrivacidadError("org_place_purge_hold: el motivo debe tener entre 10 y 300 caracteres", "invalid");
    if (this.holds.some((h) => h.orgId === orgId && h.active && h.dataClass === dataClass)) throw new PlataformaPrivacidadError("org_place_purge_hold: ya existe un bloqueo activo para esa clase", "conflict");
    this.holdSeq += 1;
    const id = randomUUID();
    this.holds.push({ id, orgId, dataClass, reason: r, placedAtMs: this.now(), releasedAtMs: null, releaseNote: null, active: true });
    return { availability: "available" as const, id };
  }

  async orgReleaseHold(orgId: string, holdId: string, note: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, released: false };
    this.requireAdmin(orgId, "org_release_purge_hold");
    const i = this.holds.findIndex((h) => h.id === holdId && h.orgId === orgId && h.active);
    if (i < 0) return { availability: "available" as const, released: false };
    const h = this.holds[i]!;
    this.holds[i] = { ...h, active: false, releasedAtMs: this.now(), releaseNote: note?.trim() ? note.trim() : null };
    return { availability: "available" as const, released: true };
  }

  async orgListPurgeRuns(orgId: string, limit: number, beforeSeq: number | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, items: [] as readonly PurgeRunRow[] };
    if (!this.isAdmin(orgId)) return { availability: "available" as const, items: [] as readonly PurgeRunRow[] };
    return { availability: "available" as const, items: this.runs.filter((r) => r.orgId === orgId && (beforeSeq === null || r.seq < beforeSeq)).sort((a, b) => b.seq - a.seq).slice(0, limit).map(({ orgId: _o, ...r }) => r) };
  }

  async orgListNotices(orgId: string, limit: number) {
    if (!this.migrado) return { availability: "not_migrated" as const, items: [] as readonly PrivacyNoticeRow[] };
    if (!this.isAdmin(orgId)) return { availability: "available" as const, items: [] as readonly PrivacyNoticeRow[] };
    const mine = this.notices.filter((n) => n.orgId === orgId).sort((a, b) => b.version - a.version);
    const current = mine[0]?.version;
    return {
      availability: "available" as const,
      items: mine.slice(0, limit).map(({ orgId: _o, acceptors, ...n }): PrivacyNoticeRow => ({ ...n, acceptedCount: acceptors.size, acceptedByCaller: acceptors.has(this.actor), isCurrent: n.version === current })),
    };
  }

  async orgPublishNotice(orgId: string, title: string, summary: string, url: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, noticeId: null as string | null, version: null as number | null };
    this.requireAdmin(orgId, "org_publish_privacy_notice");
    if (title.trim().length < 3 || title.trim().length > 200) throw new PlataformaPrivacidadError("org_publish_privacy_notice: el titulo debe tener entre 3 y 200 caracteres", "invalid");
    if (summary.trim().length < 10 || summary.trim().length > 2000) throw new PlataformaPrivacidadError("org_publish_privacy_notice: el resumen debe tener entre 10 y 2000 caracteres", "invalid");
    if (!/^https:\/\/\S+$/u.test(url.trim()) || url.trim().length > 500) throw new PlataformaPrivacidadError("org_publish_privacy_notice: la URL del aviso integral debe ser https y tener hasta 500 caracteres", "invalid");
    const version = this.notices.filter((n) => n.orgId === orgId).length + 1;
    const noticeId = `notice-${orgId}-${version}`;
    this.notices.push({ orgId, noticeId, version, title: title.trim(), summary: summary.trim(), noticeUrl: url.trim(), contentSha256: "0".repeat(64), createdAtMs: this.now(), acceptedCount: 1, acceptedByCaller: true, isCurrent: true, acceptors: new Set([this.actor]) });
    return { availability: "available" as const, noticeId, version };
  }

  async orgAcceptNotice(orgId: string, version: number) {
    if (!this.migrado) return { availability: "not_migrated" as const, accepted: false };
    this.requireAdmin(orgId, "org_accept_privacy_notice");
    const mine = this.notices.filter((n) => n.orgId === orgId);
    const target = mine.find((n) => n.version === version);
    if (!target) throw new PlataformaPrivacidadError("org_accept_privacy_notice: la version no existe para esta organizacion", "invalid");
    if (version !== Math.max(...mine.map((n) => n.version))) throw new PlataformaPrivacidadError("org_accept_privacy_notice: solo se acepta la version vigente", "invalid");
    if (target.acceptors.has(this.actor)) return { availability: "available" as const, accepted: false };
    target.acceptors.add(this.actor);
    return { availability: "available" as const, accepted: true };
  }

  async platformListArco(callerId: string, query: ArcoQuery & { readonly onlyOverdue: boolean }): Promise<ArcoPage> {
    if (!this.migrado) return NOT_MIGRATED_ARCO;
    if (!this.isReader(callerId)) return { availability: "available", total: 0, items: [] };
    const all = this.arco.filter((r) => (!query.onlyOpen || r.isOpen) && (!query.onlyOverdue || r.isOverdue));
    return { availability: "available", total: all.length, items: all.slice(query.offset, query.offset + query.limit).map(({ orgId: _o, ...r }) => r) };
  }

  async platformOverview(callerId: string, limit: number, offset: number) {
    if (!this.migrado) return { availability: "not_migrated" as const, total: 0, items: [] as readonly PrivacyOverviewRow[] };
    if (!this.isReader(callerId)) return { availability: "available" as const, total: 0, items: [] as readonly PrivacyOverviewRow[] };
    const orgs = [...new Set(this.arco.map((r) => r.orgId))];
    const items = orgs.map((orgId): PrivacyOverviewRow => {
      const mine = this.arco.filter((r) => r.orgId === orgId);
      const notice = this.notices.filter((n) => n.orgId === orgId).sort((a, b) => b.version - a.version)[0];
      const lastRun = this.runs.filter((r) => r.orgId === orgId).sort((a, b) => b.seq - a.seq)[0];
      return {
        organizationId: orgId,
        organizationName: mine[0]?.organizationName ?? orgId,
        vertical: mine[0]?.vertical ?? "",
        openArco: mine.filter((r) => r.isOpen).length,
        overdueArco: mine.filter((r) => r.isOverdue).length,
        noticeVersion: notice?.version ?? null,
        noticeAcceptances: notice?.acceptors.size ?? 0,
        activeHolds: this.holds.filter((h) => h.orgId === orgId && h.active).length,
        lastPurgeAtMs: lastRun?.createdAtMs ?? null,
        lastPurgeStatus: lastRun?.status ?? null,
      };
    });
    return { availability: "available" as const, total: items.length, items: items.slice(offset, offset + limit) };
  }

  async platformListPurgeRuns(callerId: string, limit: number, beforeSeq: number | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, items: [] as readonly PurgeRunRow[] };
    if (!this.isReader(callerId)) return { availability: "available" as const, items: [] as readonly PurgeRunRow[] };
    return { availability: "available" as const, items: this.runs.filter((r) => beforeSeq === null || r.seq < beforeSeq).sort((a, b) => b.seq - a.seq).slice(0, limit).map(({ orgId: _o, ...r }) => r) };
  }

  async runRetentionPurge(orgId: string, dataClass: string, dryRun: boolean, _limit: number) {
    if (!this.migrado) return { availability: "not_migrated" as const, result: null as PurgeRunResult | null };
    const c = this.classOf(dataClass);
    if (!c) throw new PlataformaPrivacidadError("system_run_retention_purge: clase de dato desconocida", "invalid");
    const retentionDays = this.policies.get(`${orgId}:${dataClass}`) ?? c.defaultDays;
    const blocked = this.holds.some((h) => h.orgId === orgId && h.active && (h.dataClass === null || h.dataClass === dataClass));
    const status: PurgeStatus = c.executor !== "plataforma" ? "sin_ejecutor" : blocked ? "bloqueada" : dryRun ? "simulacion" : "ok";
    this.runSeq += 1;
    const row: PurgeRunRow & { readonly orgId: string } = {
      orgId,
      seq: this.runSeq,
      organizationId: orgId,
      organizationName: orgId,
      dataClass,
      status,
      retentionDays,
      cutoffAtMs: this.now() - retentionDays * 86_400_000,
      rowsAffected: 0,
      rowsAnonymized: 0,
      rowsProtected: 0,
      blockedReason: status === "bloqueada" ? "retencion_legal_activa" : null,
      createdAtMs: this.now(),
    };
    this.runs.push(row);
    return { availability: "available" as const, result: { runId: `run-${this.runSeq}`, status, retentionDays, rowsAffected: 0, rowsAnonymized: 0, rowsProtected: 0 } };
  }

  /** Organizaciones sembradas con `seedPurgeOrg`, ordenadas por id. */
  private readonly purgeOrgs: string[] = [];
  seedPurgeOrg(orgId: string): void {
    this.purgeOrgs.push(orgId);
    this.purgeOrgs.sort();
  }

  async listPurgeTargets(afterOrgId: string | null, orgLimit: number, onlyOrgId: string | null = null) {
    if (!this.migrado) return { availability: "not_migrated" as const, targets: [] as readonly PurgeTarget[] };
    const orgs = this.purgeOrgs.filter((o) => (afterOrgId === null || o > afterOrgId) && (onlyOrgId === null || o === onlyOrgId)).slice(0, orgLimit);
    const classes = this.classes.filter((c) => c.executor === "plataforma");
    return { availability: "available" as const, targets: orgs.flatMap((organizationId) => classes.map((c): PurgeTarget => ({ organizationId, dataClass: c.dataClass }))) };
  }
}
