// SaludRepository — puerto de "Salud operativa" del back office de
// plataforma (`GET /superadmin/salud/*`, ver
// `apps/api/src/routes/superadmin-salud.ts`), MÁS el registro de latidos que
// alimentan `apps/api/src/salud/with-heartbeat.ts::withHeartbeat` (ver
// `packages/db/migrations/0014_superadmin_salud_operativa.sql`).
//
// Puerto APARTE de `LlmUsageRepository`/`CoreRepository` a propósito (mismo
// criterio que ese puerto, ver su comentario de cabecera): tabla nueva
// (`core.cron_heartbeat`) + lecturas agregadas que cruzan esquemas de
// vertical (`get_outbox_health_for_superadmin`/
// `list_licitaciones_source_runs_for_superadmin`), sin acoplar este concern
// al repositorio gigante de auth/organizaciones.
//
// Objeto FIJO (no una fábrica por-request), mismo patrón que
// `LlmUsageRepository`: `recordCronHeartbeat` es de SISTEMA (sesión
// `userId: null`), las 3 lecturas `*ForSuperadmin` abren sesión COMO el
// caller autenticado (ver `apps/api/src/production/salud-repository.ts`).
import type { TenantDbSession } from "@atiende/core-tenancy";

export type CronHeartbeatStatus = "ok" | "error";

export interface RecordCronHeartbeatInput {
  /** Path EXACTO de `vercel.json::crons` (p. ej.
   *  "/internal/licitaciones/discover-tenders") -- ver
   *  `apps/api/src/salud/cadencia.ts`. */
  readonly cronName: string;
  readonly status: CronHeartbeatStatus;
  /** `null` cuando `status === "ok"`. Truncado (500 chars) por el llamador Y
   *  por la función SQL -- defensa en profundidad, ver la migración. */
  readonly error: string | null;
  readonly startedAt: string; // ISO 8601
  readonly finishedAt: string; // ISO 8601
  readonly durationMs: number;
}

export interface CronHeartbeatRow {
  readonly cronName: string;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastStatus: CronHeartbeatStatus | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly consecutiveFailures: number;
}

export interface OutboxQueueHealthRow {
  readonly queueName: string;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
  /** `null` cuando no hay ningún mensaje `pending` (nunca `0`, que
   *  confundiría "no hay pendientes" con "el pendiente más viejo tiene 0
   *  segundos"). */
  readonly oldestPendingSeconds: number | null;
  /** `null` cuando la cola nunca marcó un envío exitoso, O cuando la tabla
   *  de esa vertical no tiene columna `sent_at` (citas/despachos/licitaciones,
   *  ver el comentario de la migración) -- ambos casos son honestos "no se
   *  sabe", nunca se infiere de `created_at`. */
  readonly lastSentAt: string | null;
}

export interface LicitacionesFuenteRunRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly source: string;
  readonly state: string;
  readonly finishedAt: string;
  readonly message: string;
}

export interface SaludRepository {
  /** Best-effort desde el punto de vista del llamador (`withHeartbeat` ya
   *  envuelve esto en try/catch) -- este método en sí SÍ puede lanzar; quien
   *  quiera "nunca lanza" debe envolver la llamada. */
  recordCronHeartbeat(input: RecordCronHeartbeatInput): Promise<void>;
  listCronHeartbeatsForSuperadmin(callerId: string): Promise<readonly CronHeartbeatRow[]>;
  getOutboxHealthForSuperadmin(callerId: string): Promise<readonly OutboxQueueHealthRow[]>;
  listLicitacionesFuenteRunsForSuperadmin(callerId: string): Promise<readonly LicitacionesFuenteRunRow[]>;
}

interface CronHeartbeatRawRow {
  cron_name: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: CronHeartbeatStatus | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
}

interface OutboxQueueHealthRawRow {
  queue_name: string;
  pending_count: string;
  processing_count: string;
  sent_count: string;
  failed_count: string;
  dead_count: string;
  oldest_pending_seconds: string | null;
  last_sent_at: string | null;
}

interface LicitacionesFuenteRunRawRow {
  organization_id: string;
  organization_name: string;
  source: string;
  state: string;
  finished_at: string;
  message: string;
}

function n(v: string | number | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}

export class PostgresSaludRepository implements SaludRepository {
  constructor(private readonly db: TenantDbSession) {}

  async recordCronHeartbeat(input: RecordCronHeartbeatInput): Promise<void> {
    await this.db.query(`select core.record_cron_heartbeat($1, $2, $3, $4, $5, $6);`, [
      input.cronName,
      input.status,
      input.startedAt,
      input.finishedAt,
      Math.trunc(input.durationMs),
      input.error,
    ]);
  }

  async listCronHeartbeatsForSuperadmin(callerId: string): Promise<readonly CronHeartbeatRow[]> {
    const { rows } = await this.db.query<CronHeartbeatRawRow>(
      `select cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms, consecutive_failures
       from core.list_cron_heartbeats_for_superadmin($1);`,
      [callerId],
    );
    return rows.map((r) => ({
      cronName: r.cron_name,
      lastStartedAt: r.last_started_at,
      lastFinishedAt: r.last_finished_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
      lastDurationMs: r.last_duration_ms === null ? null : n(r.last_duration_ms),
      consecutiveFailures: n(r.consecutive_failures),
    }));
  }

  async getOutboxHealthForSuperadmin(callerId: string): Promise<readonly OutboxQueueHealthRow[]> {
    const { rows } = await this.db.query<OutboxQueueHealthRawRow>(
      `select queue_name, pending_count, processing_count, sent_count, failed_count, dead_count, oldest_pending_seconds, last_sent_at
       from core.get_outbox_health_for_superadmin($1);`,
      [callerId],
    );
    return rows.map((r) => ({
      queueName: r.queue_name,
      pendingCount: n(r.pending_count),
      processingCount: n(r.processing_count),
      sentCount: n(r.sent_count),
      failedCount: n(r.failed_count),
      deadCount: n(r.dead_count),
      oldestPendingSeconds: r.oldest_pending_seconds === null ? null : n(r.oldest_pending_seconds),
      lastSentAt: r.last_sent_at,
    }));
  }

  async listLicitacionesFuenteRunsForSuperadmin(callerId: string): Promise<readonly LicitacionesFuenteRunRow[]> {
    const { rows } = await this.db.query<LicitacionesFuenteRunRawRow>(
      `select organization_id, organization_name, source, state, finished_at, message
       from core.list_licitaciones_source_runs_for_superadmin($1);`,
      [callerId],
    );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      source: r.source,
      state: r.state,
      finishedAt: r.finished_at,
      message: r.message,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// InMemorySaludRepository — referencia real (no un mock) para tests. Mismo
// criterio que `InMemoryLlmUsageRepository`: mantiene su propio set de
// superadmins (`addPlatformSuperadmin`) porque las funciones SQL reales
// verifican `is_platform_superadmin` por dentro -- un caller no-superadmin
// debe ver 0 filas también en memoria, para que las pruebas de ruta sean
// equivalentes al comportamiento real.
// ═══════════════════════════════════════════════════════════════════════════
export class InMemorySaludRepository implements SaludRepository {
  private readonly heartbeats = new Map<string, CronHeartbeatRow>();
  private outboxQueues: readonly OutboxQueueHealthRow[] = [];
  private licitacionesFuentes: readonly LicitacionesFuenteRunRow[] = [];
  private readonly isSuperadmin = new Set<string>();

  addPlatformSuperadmin(staffId: string): void {
    this.isSuperadmin.add(staffId);
  }

  /** Solo para tests -- fija el resultado que `getOutboxHealthForSuperadmin`
   *  devolverá (el repo en memoria no simula las 6 tablas reales de
   *  outbox). */
  seedOutboxHealth(rows: readonly OutboxQueueHealthRow[]): void {
    this.outboxQueues = rows;
  }

  /** Solo para tests -- mismo criterio que `seedOutboxHealth`. */
  seedLicitacionesFuenteRuns(rows: readonly LicitacionesFuenteRunRow[]): void {
    this.licitacionesFuentes = rows;
  }

  async recordCronHeartbeat(input: RecordCronHeartbeatInput): Promise<void> {
    if (input.status !== "ok" && input.status !== "error") {
      throw new Error(`p_status inválido: ${String(input.status)}, se esperaba ok|error`);
    }
    const existing = this.heartbeats.get(input.cronName);
    const consecutiveFailures = input.status === "error" ? (existing?.consecutiveFailures ?? 0) + 1 : 0;
    this.heartbeats.set(input.cronName, {
      cronName: input.cronName,
      lastStartedAt: input.startedAt,
      lastFinishedAt: input.finishedAt,
      lastStatus: input.status,
      lastError: input.error === null ? null : input.error.slice(0, 500),
      lastDurationMs: Math.max(0, Math.trunc(input.durationMs)),
      consecutiveFailures,
    });
  }

  async listCronHeartbeatsForSuperadmin(callerId: string): Promise<readonly CronHeartbeatRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return [...this.heartbeats.values()].sort((a, b) => a.cronName.localeCompare(b.cronName));
  }

  async getOutboxHealthForSuperadmin(callerId: string): Promise<readonly OutboxQueueHealthRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return this.outboxQueues;
  }

  async listLicitacionesFuenteRunsForSuperadmin(callerId: string): Promise<readonly LicitacionesFuenteRunRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return this.licitacionesFuentes;
  }
}
