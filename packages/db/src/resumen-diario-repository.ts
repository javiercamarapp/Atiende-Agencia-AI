// ResumenDiarioRepository — puerto del RESUMEN DIARIO AUTOMÁTICO del back
// office de plataforma (segunda pieza del "cerebro" de backoffice, después de
// Salud operativa, ver `packages/db/migrations/0015_superadmin_resumen_
// diario.sql` para el diseño completo de las 15 funciones nuevas + la tabla
// `core.daily_ops_summary`).
//
// MISMO criterio que `SaludRepository`/`LlmUsageRepository`: puerto APARTE
// (no una extensión de ninguno de los dos) porque cruza fuentes de las 4
// piezas de plataforma ya existentes (salud/gasto de LLM/facturación/
// prospectos) MÁS secciones nuevas (organizaciones/staff/break-glass/
// correos de superadmins) en lecturas de SOLO-SISTEMA que ninguno de esos dos
// puertos expone (sus lecturas `*ForSuperadmin` exigen `auth.uid() =
// p_caller_id`, nunca invocables desde la sesión de sistema del cron, ver el
// comentario de cabecera de la migración).
//
// Objeto FIJO (no una fábrica por-request) — TODOS los métodos de este puerto
// corren sobre sesión de SISTEMA (`userId: null`) salvo los 2 de lectura
// `*ForSuperadmin` del final, que abren sesión COMO el caller — MISMO patrón
// que `ProductionSaludRepository` (ver `apps/api/src/production/resumen-
// diario-repository.ts`).
import type { TenantDbSession } from "@atiende/core-tenancy";

/** Rango `[desde, hasta)` en UTC de un día calendario de America/Mexico_City
 *  — SIEMPRE calculado en TS puro (ver `apps/api/src/resumen-diario/
 *  motor.ts::ventanaDiaMexico`), nunca por este puerto ni por Postgres. */
export interface VentanaDia {
  readonly desde: string; // ISO 8601 UTC
  readonly hasta: string; // ISO 8601 UTC
}

export type CronHeartbeatStatus = "ok" | "error";

export interface CronHeartbeatSystemRow {
  readonly cronName: string;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastStatus: CronHeartbeatStatus | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly consecutiveFailures: number;
}

export interface OutboxDiarioRow {
  readonly queueName: string;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
  readonly oldestPendingSeconds: number | null;
  readonly lastSentAt: string | null;
  /** `null` cuando la vertical no tiene columna `sent_at` (citas/despachos/
   *  licitaciones) -- NUNCA `0` (ver la migración). */
  readonly sentHoy: number | null;
  readonly fallidosHoy: number;
  readonly muertosHoy: number;
}

export interface LicitacionesFuenteRunSystemRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly source: string;
  readonly state: string;
  readonly finishedAt: string;
  readonly message: string;
}

export interface LlmPlatformBudgetSystemRow {
  readonly monthlyCapMicroUsd: number;
  readonly alertThresholdPct: number;
  readonly spendThisMonthMicroUsd: number;
}

export interface LlmUsageTotalRow {
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly callCount: number;
}

export interface LlmUsageTopOrganizacionRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly costMicroUsd: number;
  readonly callCount: number;
}

export interface OrganizacionesStaffNuevosRow {
  readonly organizacionesNuevas: number;
  readonly nombresOrganizacionesNuevas: readonly string[];
  readonly staffNuevos: number;
}

export interface ProspectosAgregadoRow {
  readonly altas: number;
  readonly cambiosEstado: number;
  readonly sinMovimiento: number;
}

export interface FacturacionAgregadoRow {
  readonly altas: number;
  readonly bajas: number;
  readonly morososNuevos: number;
  readonly activasTotal: number;
  readonly pagoPendienteTotal: number;
  readonly canceladaTotal: number;
  readonly sinSuscripcionTotal: number;
}

export type GeneradoPor = "llm" | "determinista";

export interface DailyOpsSummaryRow {
  readonly fecha: string; // YYYY-MM-DD
  readonly agregados: unknown; // DiarioAgregados (ver apps/api/src/resumen-diario/motor.ts), ya parseado de jsonb
  readonly narrativa: string;
  readonly generadoPor: GeneradoPor;
  readonly costoLlmMicroUsd: number | null;
  readonly modeloLlm: string | null;
  readonly proveedorLlm: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
  readonly correoEnviadoEn: string | null;
}

export interface UpsertDailyOpsSummaryInput {
  readonly fecha: string;
  readonly agregados: unknown;
  readonly narrativa: string;
  readonly generadoPor: GeneradoPor;
  readonly costoLlmMicroUsd: number | null;
  readonly modeloLlm: string | null;
  readonly proveedorLlm: string | null;
}

export interface ResumenDiarioRepository {
  // ── Lecturas de fuente, de sistema (cron/agregador) ──
  listCronHeartbeatsForSystem(): Promise<readonly CronHeartbeatSystemRow[]>;
  getOutboxHealthForSystem(ventana: VentanaDia): Promise<readonly OutboxDiarioRow[]>;
  listLicitacionesFuenteRunsForSystem(): Promise<readonly LicitacionesFuenteRunSystemRow[]>;
  getLlmPlatformBudgetForSystem(): Promise<LlmPlatformBudgetSystemRow | null>;
  getLlmUsageTotalForSystem(fecha: string): Promise<LlmUsageTotalRow>;
  listLlmUsageTopOrganizacionesForSystem(fecha: string, limit: number): Promise<readonly LlmUsageTopOrganizacionRow[]>;
  getOrganizacionesStaffNuevosForSystem(ventana: VentanaDia): Promise<OrganizacionesStaffNuevosRow>;
  getProspectosAgregadoForSystem(ventana: VentanaDia, umbralSinMovimiento: string): Promise<ProspectosAgregadoRow>;
  getFacturacionAgregadoForSystem(ventana: VentanaDia): Promise<FacturacionAgregadoRow>;
  countBreakGlassAbiertosForSystem(ventana: VentanaDia): Promise<number>;
  listPlatformSuperadminEmailsForSystem(): Promise<readonly string[]>;

  /** Resumen YA persistido de una fecha puntual, leído en sesión de SISTEMA
   *  -- usado por el agregador para traer el resumen de ayer y calcular
   *  deltas (ver `../../apps/api/src/resumen-diario/agregador.ts`). */
  getDailyOpsSummaryForSystem(fecha: string): Promise<DailyOpsSummaryRow | null>;

  // ── Escritura de sistema sobre daily_ops_summary ──
  upsertDailyOpsSummary(input: UpsertDailyOpsSummaryInput): Promise<void>;
  /** `true` si esta llamada SÍ marcó el envío (primera vez); `false` si ya
   *  estaba marcado o la fecha no existe todavía -- ver el comentario de la
   *  función SQL para por qué esto es lo que hace "un solo envío por fecha"
   *  seguro frente a reintentos. */
  markDailyOpsSummaryEmailSent(fecha: string): Promise<boolean>;

  // ── Lecturas para el back office (superadmin real) ──
  listDailyOpsSummariesForSuperadmin(callerId: string, limit: number): Promise<readonly DailyOpsSummaryRow[]>;
  getDailyOpsSummaryForSuperadmin(callerId: string, fecha: string): Promise<DailyOpsSummaryRow | null>;
}

function n(v: string | number | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}
function nOrNull(v: string | number | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
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

interface OutboxDiarioRawRow {
  queue_name: string;
  pending_count: string;
  processing_count: string;
  sent_count: string;
  failed_count: string;
  dead_count: string;
  oldest_pending_seconds: string | null;
  last_sent_at: string | null;
  sent_hoy: string | null;
  fallidos_hoy: string;
  muertos_hoy: string;
}

interface LicitacionesFuenteRunRawRow {
  organization_id: string;
  organization_name: string;
  source: string;
  state: string;
  finished_at: string;
  message: string;
}

interface LlmPlatformBudgetRawRow {
  monthly_cap_micro_usd: string;
  alert_threshold_pct: string;
  spend_this_month_micro_usd: string;
}

interface LlmUsageTotalRawRow {
  cost_micro_usd: string;
  tokens_in: string;
  tokens_out: string;
  call_count: string;
}

interface LlmUsageTopOrganizacionRawRow {
  organization_id: string;
  organization_name: string;
  vertical: string;
  cost_micro_usd: string;
  call_count: string;
}

interface OrganizacionesStaffNuevosRawRow {
  organizaciones_nuevas: string;
  nombres_organizaciones_nuevas: string[] | null;
  staff_nuevos: string;
}

interface ProspectosAgregadoRawRow {
  altas: string;
  cambios_estado: string;
  sin_movimiento: string;
}

interface FacturacionAgregadoRawRow {
  altas: string;
  bajas: string;
  morosos_nuevos: string;
  activas_total: string;
  pago_pendiente_total: string;
  cancelada_total: string;
  sin_suscripcion_total: string;
}

interface DailyOpsSummaryRawRow {
  fecha: string;
  agregados: unknown;
  narrativa: string;
  generado_por: GeneradoPor;
  costo_llm_micro_usd: string | null;
  modelo_llm: string | null;
  proveedor_llm: string | null;
  creado_en: string;
  actualizado_en: string;
  correo_enviado_en: string | null;
}

function mapDailyOpsSummary(r: DailyOpsSummaryRawRow): DailyOpsSummaryRow {
  return {
    fecha: r.fecha,
    agregados: r.agregados,
    narrativa: r.narrativa,
    generadoPor: r.generado_por,
    costoLlmMicroUsd: nOrNull(r.costo_llm_micro_usd),
    modeloLlm: r.modelo_llm,
    proveedorLlm: r.proveedor_llm,
    creadoEn: r.creado_en,
    actualizadoEn: r.actualizado_en,
    correoEnviadoEn: r.correo_enviado_en,
  };
}

export class PostgresResumenDiarioRepository implements ResumenDiarioRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listCronHeartbeatsForSystem(): Promise<readonly CronHeartbeatSystemRow[]> {
    const { rows } = await this.db.query<CronHeartbeatRawRow>(`select cron_name, last_started_at, last_finished_at, last_status, last_error, last_duration_ms, consecutive_failures from core.list_cron_heartbeats_for_system();`);
    return rows.map((r) => ({
      cronName: r.cron_name,
      lastStartedAt: r.last_started_at,
      lastFinishedAt: r.last_finished_at,
      lastStatus: r.last_status,
      lastError: r.last_error,
      lastDurationMs: nOrNull(r.last_duration_ms),
      consecutiveFailures: n(r.consecutive_failures),
    }));
  }

  async getOutboxHealthForSystem(ventana: VentanaDia): Promise<readonly OutboxDiarioRow[]> {
    const { rows } = await this.db.query<OutboxDiarioRawRow>(
      `select queue_name, pending_count, processing_count, sent_count, failed_count, dead_count, oldest_pending_seconds, last_sent_at, sent_hoy, fallidos_hoy, muertos_hoy
       from core.get_outbox_health_for_system($1, $2);`,
      [ventana.desde, ventana.hasta],
    );
    return rows.map((r) => ({
      queueName: r.queue_name,
      pendingCount: n(r.pending_count),
      processingCount: n(r.processing_count),
      sentCount: n(r.sent_count),
      failedCount: n(r.failed_count),
      deadCount: n(r.dead_count),
      oldestPendingSeconds: nOrNull(r.oldest_pending_seconds),
      lastSentAt: r.last_sent_at,
      sentHoy: nOrNull(r.sent_hoy),
      fallidosHoy: n(r.fallidos_hoy),
      muertosHoy: n(r.muertos_hoy),
    }));
  }

  async listLicitacionesFuenteRunsForSystem(): Promise<readonly LicitacionesFuenteRunSystemRow[]> {
    const { rows } = await this.db.query<LicitacionesFuenteRunRawRow>(`select organization_id, organization_name, source, state, finished_at, message from core.list_licitaciones_source_runs_for_system();`);
    return rows.map((r) => ({ organizationId: r.organization_id, organizationName: r.organization_name, source: r.source, state: r.state, finishedAt: r.finished_at, message: r.message }));
  }

  async getLlmPlatformBudgetForSystem(): Promise<LlmPlatformBudgetSystemRow | null> {
    const { rows } = await this.db.query<LlmPlatformBudgetRawRow>(`select monthly_cap_micro_usd, alert_threshold_pct, spend_this_month_micro_usd from core.get_llm_platform_budget_for_system();`);
    const row = rows[0];
    if (!row) return null;
    return { monthlyCapMicroUsd: n(row.monthly_cap_micro_usd), alertThresholdPct: n(row.alert_threshold_pct), spendThisMonthMicroUsd: n(row.spend_this_month_micro_usd) };
  }

  async getLlmUsageTotalForSystem(fecha: string): Promise<LlmUsageTotalRow> {
    const { rows } = await this.db.query<LlmUsageTotalRawRow>(`select cost_micro_usd, tokens_in, tokens_out, call_count from core.get_llm_usage_total_for_system($1);`, [fecha]);
    const row = rows[0];
    return { costMicroUsd: n(row?.cost_micro_usd), tokensIn: n(row?.tokens_in), tokensOut: n(row?.tokens_out), callCount: n(row?.call_count) };
  }

  async listLlmUsageTopOrganizacionesForSystem(fecha: string, limit: number): Promise<readonly LlmUsageTopOrganizacionRow[]> {
    const { rows } = await this.db.query<LlmUsageTopOrganizacionRawRow>(`select organization_id, organization_name, vertical, cost_micro_usd, call_count from core.list_llm_usage_top_organizaciones_for_system($1, $2);`, [fecha, limit]);
    return rows.map((r) => ({ organizationId: r.organization_id, organizationName: r.organization_name, vertical: r.vertical, costMicroUsd: n(r.cost_micro_usd), callCount: n(r.call_count) }));
  }

  async getOrganizacionesStaffNuevosForSystem(ventana: VentanaDia): Promise<OrganizacionesStaffNuevosRow> {
    const { rows } = await this.db.query<OrganizacionesStaffNuevosRawRow>(`select organizaciones_nuevas, nombres_organizaciones_nuevas, staff_nuevos from core.get_organizaciones_staff_nuevos_for_system($1, $2);`, [ventana.desde, ventana.hasta]);
    const row = rows[0];
    return { organizacionesNuevas: n(row?.organizaciones_nuevas), nombresOrganizacionesNuevas: row?.nombres_organizaciones_nuevas ?? [], staffNuevos: n(row?.staff_nuevos) };
  }

  async getProspectosAgregadoForSystem(ventana: VentanaDia, umbralSinMovimiento: string): Promise<ProspectosAgregadoRow> {
    const { rows } = await this.db.query<ProspectosAgregadoRawRow>(`select altas, cambios_estado, sin_movimiento from core.get_prospectos_agregado_for_system($1, $2, $3);`, [ventana.desde, ventana.hasta, umbralSinMovimiento]);
    const row = rows[0];
    return { altas: n(row?.altas), cambiosEstado: n(row?.cambios_estado), sinMovimiento: n(row?.sin_movimiento) };
  }

  async getFacturacionAgregadoForSystem(ventana: VentanaDia): Promise<FacturacionAgregadoRow> {
    const { rows } = await this.db.query<FacturacionAgregadoRawRow>(
      `select altas, bajas, morosos_nuevos, activas_total, pago_pendiente_total, cancelada_total, sin_suscripcion_total from core.get_facturacion_agregado_for_system($1, $2);`,
      [ventana.desde, ventana.hasta],
    );
    const row = rows[0];
    return {
      altas: n(row?.altas),
      bajas: n(row?.bajas),
      morososNuevos: n(row?.morosos_nuevos),
      activasTotal: n(row?.activas_total),
      pagoPendienteTotal: n(row?.pago_pendiente_total),
      canceladaTotal: n(row?.cancelada_total),
      sinSuscripcionTotal: n(row?.sin_suscripcion_total),
    };
  }

  async countBreakGlassAbiertosForSystem(ventana: VentanaDia): Promise<number> {
    const { rows } = await this.db.query<{ count_break_glass_abiertos_for_system: string }>(`select core.count_break_glass_abiertos_for_system($1, $2);`, [ventana.desde, ventana.hasta]);
    return n(rows[0]?.count_break_glass_abiertos_for_system);
  }

  async listPlatformSuperadminEmailsForSystem(): Promise<readonly string[]> {
    const { rows } = await this.db.query<{ email: string }>(`select email from core.list_platform_superadmin_emails_for_system();`);
    return rows.map((r) => r.email);
  }

  async getDailyOpsSummaryForSystem(fecha: string): Promise<DailyOpsSummaryRow | null> {
    const { rows } = await this.db.query<DailyOpsSummaryRawRow>(
      `select fecha, agregados, narrativa, generado_por, costo_llm_micro_usd, modelo_llm, proveedor_llm, creado_en, actualizado_en, correo_enviado_en
       from core.get_daily_ops_summary_for_system($1);`,
      [fecha],
    );
    const row = rows[0];
    return row ? mapDailyOpsSummary(row) : null;
  }

  async upsertDailyOpsSummary(input: UpsertDailyOpsSummaryInput): Promise<void> {
    await this.db.query(`select core.upsert_daily_ops_summary($1, $2, $3, $4, $5, $6, $7);`, [
      input.fecha,
      JSON.stringify(input.agregados),
      input.narrativa,
      input.generadoPor,
      input.costoLlmMicroUsd,
      input.modeloLlm,
      input.proveedorLlm,
    ]);
  }

  async markDailyOpsSummaryEmailSent(fecha: string): Promise<boolean> {
    const { rows } = await this.db.query<{ mark_daily_ops_summary_email_sent: boolean }>(`select core.mark_daily_ops_summary_email_sent($1);`, [fecha]);
    return rows[0]?.mark_daily_ops_summary_email_sent ?? false;
  }

  async listDailyOpsSummariesForSuperadmin(callerId: string, limit: number): Promise<readonly DailyOpsSummaryRow[]> {
    const { rows } = await this.db.query<DailyOpsSummaryRawRow>(
      `select fecha, agregados, narrativa, generado_por, costo_llm_micro_usd, modelo_llm, proveedor_llm, creado_en, actualizado_en, correo_enviado_en
       from core.list_daily_ops_summaries_for_superadmin($1, $2);`,
      [callerId, limit],
    );
    return rows.map(mapDailyOpsSummary);
  }

  async getDailyOpsSummaryForSuperadmin(callerId: string, fecha: string): Promise<DailyOpsSummaryRow | null> {
    const { rows } = await this.db.query<DailyOpsSummaryRawRow>(
      `select fecha, agregados, narrativa, generado_por, costo_llm_micro_usd, modelo_llm, proveedor_llm, creado_en, actualizado_en, correo_enviado_en
       from core.get_daily_ops_summary_for_superadmin($1, $2);`,
      [callerId, fecha],
    );
    const row = rows[0];
    return row ? mapDailyOpsSummary(row) : null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// InMemoryResumenDiarioRepository — referencia real (no un mock) para tests.
// Mismo criterio que InMemorySaludRepository/InMemoryLlmUsageRepository:
// mantiene su propio set de superadmins (`addPlatformSuperadmin`) porque las
// funciones SQL reales verifican `is_platform_superadmin` por dentro -- un
// caller no-superadmin debe ver 0 filas/null también en memoria.
// ═══════════════════════════════════════════════════════════════════════════
export class InMemoryResumenDiarioRepository implements ResumenDiarioRepository {
  private cronHeartbeats: readonly CronHeartbeatSystemRow[] = [];
  private outbox: readonly OutboxDiarioRow[] = [];
  private licitacionesFuentes: readonly LicitacionesFuenteRunSystemRow[] = [];
  private llmPlatformBudget: LlmPlatformBudgetSystemRow | null = null;
  private llmUsageTotal: LlmUsageTotalRow = { costMicroUsd: 0, tokensIn: 0, tokensOut: 0, callCount: 0 };
  private llmUsageTopOrganizaciones: readonly LlmUsageTopOrganizacionRow[] = [];
  private organizacionesStaffNuevos: OrganizacionesStaffNuevosRow = { organizacionesNuevas: 0, nombresOrganizacionesNuevas: [], staffNuevos: 0 };
  private prospectosAgregado: ProspectosAgregadoRow = { altas: 0, cambiosEstado: 0, sinMovimiento: 0 };
  private facturacionAgregado: FacturacionAgregadoRow = { altas: 0, bajas: 0, morososNuevos: 0, activasTotal: 0, pagoPendienteTotal: 0, canceladaTotal: 0, sinSuscripcionTotal: 0 };
  private breakGlassAbiertos = 0;
  private platformSuperadminEmails: readonly string[] = [];
  private readonly summaries = new Map<string, DailyOpsSummaryRow>();
  private readonly isSuperadmin = new Set<string>();

  /** Cuando se pasa `true`, cada lectura de fuente lanza -- para probar la
   *  degradación a `null` sección-por-sección del agregador. */
  private fallando = false;

  addPlatformSuperadmin(staffId: string): void {
    this.isSuperadmin.add(staffId);
  }
  seedCronHeartbeats(rows: readonly CronHeartbeatSystemRow[]): void {
    this.cronHeartbeats = rows;
  }
  seedOutbox(rows: readonly OutboxDiarioRow[]): void {
    this.outbox = rows;
  }
  seedLicitacionesFuentes(rows: readonly LicitacionesFuenteRunSystemRow[]): void {
    this.licitacionesFuentes = rows;
  }
  seedLlmPlatformBudget(row: LlmPlatformBudgetSystemRow | null): void {
    this.llmPlatformBudget = row;
  }
  seedLlmUsageTotal(row: LlmUsageTotalRow): void {
    this.llmUsageTotal = row;
  }
  seedLlmUsageTopOrganizaciones(rows: readonly LlmUsageTopOrganizacionRow[]): void {
    this.llmUsageTopOrganizaciones = rows;
  }
  seedOrganizacionesStaffNuevos(row: OrganizacionesStaffNuevosRow): void {
    this.organizacionesStaffNuevos = row;
  }
  seedProspectosAgregado(row: ProspectosAgregadoRow): void {
    this.prospectosAgregado = row;
  }
  seedFacturacionAgregado(row: FacturacionAgregadoRow): void {
    this.facturacionAgregado = row;
  }
  seedBreakGlassAbiertos(count: number): void {
    this.breakGlassAbiertos = count;
  }
  seedPlatformSuperadminEmails(emails: readonly string[]): void {
    this.platformSuperadminEmails = emails;
  }
  /** Solo para tests -- simula que TODAS las lecturas de fuente fallan (fixture
   *  de "no se pudo leer" del agregador). */
  setFallando(fallando: boolean): void {
    this.fallando = fallando;
  }

  /** Solo para tests -- simula la migración `0015_superadmin_resumen_diario.sql`
   *  SIN APLICAR: `listCronHeartbeatsForSystem` (el sondeo barato del
   *  agregador) y `upsertDailyOpsSummary` (el UPSERT final) lanzan con
   *  `.code = "42883"`, exactamente como el driver `pg` real reporta
   *  `undefined_function` -- fixture del hallazgo de auditoría a1 (rubro B:
   *  el cron/"generar ahora" respondían 500 en vez de un vacío honesto). */
  private migracionPendiente = false;
  setMigracionPendiente(pendiente: boolean): void {
    this.migracionPendiente = pendiente;
  }

  /** Solo para tests -- simula el caso de carrera de "defensa en profundidad"
   *  donde el sondeo (`listCronHeartbeatsForSystem`) SÍ pasa pero el UPSERT
   *  final falla igual con 42883 (p. ej. la migración se aplicó a la mitad
   *  entre el sondeo y el UPSERT) -- independiente de `setMigracionPendiente`,
   *  que hace fallar AMBOS. */
  private upsertMigracionPendiente = false;
  setUpsertMigracionPendiente(pendiente: boolean): void {
    this.upsertMigracionPendiente = pendiente;
  }

  private checarFalla(): void {
    if (this.fallando) throw new Error("InMemoryResumenDiarioRepository: lectura simulada como fallida");
  }

  private lanzarUndefinedFunction(nombreFuncion: string): never {
    const err = new Error(`function ${nombreFuncion} does not exist`) as Error & { code: string };
    err.code = "42883";
    throw err;
  }

  private checarMigracionPendiente(): void {
    if (this.migracionPendiente) this.lanzarUndefinedFunction("core.list_cron_heartbeats_for_system()");
  }

  async listCronHeartbeatsForSystem(): Promise<readonly CronHeartbeatSystemRow[]> {
    this.checarMigracionPendiente();
    this.checarFalla();
    return this.cronHeartbeats;
  }
  async getOutboxHealthForSystem(): Promise<readonly OutboxDiarioRow[]> {
    this.checarFalla();
    return this.outbox;
  }
  async listLicitacionesFuenteRunsForSystem(): Promise<readonly LicitacionesFuenteRunSystemRow[]> {
    this.checarFalla();
    return this.licitacionesFuentes;
  }
  async getLlmPlatformBudgetForSystem(): Promise<LlmPlatformBudgetSystemRow | null> {
    this.checarFalla();
    return this.llmPlatformBudget;
  }
  async getLlmUsageTotalForSystem(): Promise<LlmUsageTotalRow> {
    this.checarFalla();
    return this.llmUsageTotal;
  }
  async listLlmUsageTopOrganizacionesForSystem(): Promise<readonly LlmUsageTopOrganizacionRow[]> {
    this.checarFalla();
    return this.llmUsageTopOrganizaciones;
  }
  async getOrganizacionesStaffNuevosForSystem(): Promise<OrganizacionesStaffNuevosRow> {
    this.checarFalla();
    return this.organizacionesStaffNuevos;
  }
  async getProspectosAgregadoForSystem(): Promise<ProspectosAgregadoRow> {
    this.checarFalla();
    return this.prospectosAgregado;
  }
  async getFacturacionAgregadoForSystem(): Promise<FacturacionAgregadoRow> {
    this.checarFalla();
    return this.facturacionAgregado;
  }
  async countBreakGlassAbiertosForSystem(): Promise<number> {
    this.checarFalla();
    return this.breakGlassAbiertos;
  }
  async listPlatformSuperadminEmailsForSystem(): Promise<readonly string[]> {
    this.checarFalla();
    return this.platformSuperadminEmails;
  }

  async getDailyOpsSummaryForSystem(fecha: string): Promise<DailyOpsSummaryRow | null> {
    return this.summaries.get(fecha) ?? null;
  }

  async upsertDailyOpsSummary(input: UpsertDailyOpsSummaryInput): Promise<void> {
    if (this.migracionPendiente || this.upsertMigracionPendiente) this.lanzarUndefinedFunction("core.upsert_daily_ops_summary(date,jsonb,text,text,bigint,text,text)");
    const existente = this.summaries.get(input.fecha);
    const ahora = new Date().toISOString();
    this.summaries.set(input.fecha, {
      fecha: input.fecha,
      agregados: input.agregados,
      narrativa: input.narrativa,
      generadoPor: input.generadoPor,
      costoLlmMicroUsd: input.generadoPor === "llm" ? input.costoLlmMicroUsd : null,
      modeloLlm: input.generadoPor === "llm" ? input.modeloLlm : null,
      proveedorLlm: input.generadoPor === "llm" ? input.proveedorLlm : null,
      creadoEn: existente?.creadoEn ?? ahora,
      actualizadoEn: ahora,
      correoEnviadoEn: existente?.correoEnviadoEn ?? null,
    });
  }

  async markDailyOpsSummaryEmailSent(fecha: string): Promise<boolean> {
    const existente = this.summaries.get(fecha);
    if (!existente || existente.correoEnviadoEn !== null) return false;
    this.summaries.set(fecha, { ...existente, correoEnviadoEn: new Date().toISOString() });
    return true;
  }

  async listDailyOpsSummariesForSuperadmin(callerId: string, limit: number): Promise<readonly DailyOpsSummaryRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    return [...this.summaries.values()].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, Math.max(1, limit));
  }

  async getDailyOpsSummaryForSuperadmin(callerId: string, fecha: string): Promise<DailyOpsSummaryRow | null> {
    if (!this.isSuperadmin.has(callerId)) return null;
    return this.summaries.get(fecha) ?? null;
  }
}
