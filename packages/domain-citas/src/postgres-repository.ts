// PostgresCitasRepository — adaptador de producción de `CitasRepository` sobre
// `TenantDbSession` (el mismo contrato genérico que @atiende/core-tenancy define y
// consume core-auth/src/middleware.ts). Ejecuta las queries y RPCs reales contra
// `citas.*` (migrations/001-003) y `core.organization`/`core.property`
// (packages/db/migrations/0001_core_schema.sql).
//
// Se abre siempre vía `TenancyEngine.withAppSession({ userId: null }, ...)` para las
// rutas públicas/de sistema (crear-cita, cancelar/reagendar vía agente, recordatorio
// interno) — ninguna de ellas usa un `auth.uid()` real (ver diseño Fase 1 §5); la
// ruta de staff (cancelar desde panel) sí abre sesión con el userId real, que es lo
// que `cancelAppointmentFromPanel` recibe como `actorUserId`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { configAgenteDesdeFila, fotoConfigAgente } from "./whatsapp/agent-config.ts";
import type { AgenteConfigGuardado, ConectarNumeroResultado, DesconectarNumeroResultado, WhatsappAgentConfig, WhatsappAgentConfigRecord, WhatsappConnection } from "./whatsapp/agent-config.ts";
import { fotoConfigMensajes } from "./whatsapp/message-config.ts";
import { variantesTelefonoEntrante } from "./whatsapp/proactivo.ts";
import type { PlantillaWhatsappAprobada } from "./whatsapp/proactivo.ts";
import type { PlantillaWhatsappInput, PlantillaWhatsappRecord } from "./whatsapp/plantillas.ts";
import { actorHash } from "./rate-limit.ts";
import type { MensajeConfigGuardado, WhatsappMessageConfig, WhatsappMessageConfigHistoryEntry, WhatsappMessageConfigRecord } from "./whatsapp/message-config.ts";
import { emitirNotificacion, isMigrationPendingError, isUndefinedFunctionError, runWithSavepointFallback } from "@atiende/db";
import type {
  ConfirmDataRightsOutcome,
  DataRightsEventRow,
  DataRightsPaginacion,
  DataRightsRequestRow,
  DataRightsRequestsFiltro,
  DataRightsRequestsPage,
  DataRightStaffTargetStatus,
  DataRightStatus,
  DataRightType,
  RegisterDataRightsOutcome,
  UpdateDataRightsStatusResult,
} from "./data-rights.ts";
import type {
  AppointmentActorChannel,
  AppointmentRecord,
  AppointmentSource,
  AppointmentStatus,
  AvailabilityOverride,
  AvailabilityOverrideInput,
  AvailabilityRule,
  AvailabilityRulePatch,
  BusyInterval,
  CitasAuditLogFiltro,
  CitasAuditLogPagina,
  CitasAuditLogPaginacion,
  CitasAuditLogRow,
  CustomerRecord,
  GoogleSyncStatus,
  NewAvailabilityRuleInput,
  NewProviderInput,
  NewServiceInput,
  ProviderCalendarAccountRecord,
  ProviderPatch,
  ProviderRecord,
  RegistrarCitasAuditoriaInput,
  ServicePatch,
  ServiceRecord,
} from "./types.ts";
import type {
  AppointmentSyncRow,
  AvisosResumenSistema,
  CalendarProviderSyncStatus,
  CalendarSyncIssuesSummary,
  CancelResult,
  CitasRepository,
  CompleteResult,
  ConfirmResult,
  CustomerConfirmResult,
  ConnectProviderCalComAccountInput,
  ConnectProviderCalDavAccountInput,
  ConnectProviderCalendarAccountInput,
  ConversationMessage,
  CreateAppointmentResult,
  CreateFromPanelResult,
  CustomerPage,
  EmailOutboxJobRow,
  EmergencyEscalationInput,
  EmergencyEscalationRecord,
  EscalacionesPage,
  EscalacionSeguimientoDestino,
  EscalacionSeguimientoEstado,
  EscalacionVista,
  MessagingOutboxRow,
  NewAppointmentFromPanelInput,
  NewAppointmentInput,
  NoShowResult,
  ProviderCalComAccountRecord,
  ProviderCalDavAccountRecord,
  ReassignResult,
  RescheduleResult,
  RecordatorioEntregaFila,
  ReminderCandidateRow,
  RetryCalendarSyncResult,
  SetEscalacionSeguimientoResult,
  TenantConfigPatch,
  TenantConfigRecord,
  WaitlistCandidateRow,
  UpsertCustomerOptions,
} from "./repository.ts";

interface ProviderRow {
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly display_name: string;
  readonly role_label: string;
  readonly is_active: boolean;
}

function mapProvider(row: ProviderRow): ProviderRecord {
  return { id: row.id, organizationId: row.organization_id, propertyId: row.property_id, displayName: row.display_name, roleLabel: row.role_label, isActive: row.is_active };
}

interface ServiceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly name: string;
  readonly duration_minutes: number;
  readonly buffer_minutes_before: number;
  readonly buffer_minutes_after: number;
  readonly price_cents: number | null;
  readonly is_active: boolean;
}

interface AvailabilityRuleRow {
  readonly id: string;
  readonly provider_id: string;
  readonly day_of_week: number;
  readonly start_time: string;
  readonly end_time: string;
  readonly is_active: boolean;
}

function mapAvailabilityRule(row: AvailabilityRuleRow): AvailabilityRule {
  return { id: row.id, providerId: row.provider_id, dayOfWeek: row.day_of_week, startTime: row.start_time, endTime: row.end_time, isActive: row.is_active };
}

interface AvailabilityOverrideRow {
  readonly provider_id: string;
  readonly override_date: string;
  readonly is_closed: boolean;
  readonly start_time: string | null;
  readonly end_time: string | null;
  readonly reason: string | null;
}

function mapAvailabilityOverride(row: AvailabilityOverrideRow): AvailabilityOverride {
  return { providerId: row.provider_id, overrideDate: row.override_date, isClosed: row.is_closed, startTime: row.start_time, endTime: row.end_time, reason: row.reason };
}

function mapService(row: ServiceRow): ServiceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    bufferMinutesBefore: row.buffer_minutes_before,
    bufferMinutesAfter: row.buffer_minutes_after,
    priceCents: row.price_cents,
    isActive: row.is_active,
  };
}

interface AppointmentRow {
  readonly id: string;
  readonly organization_id: string;
  readonly property_id: string | null;
  readonly provider_id: string;
  readonly service_id: string;
  readonly customer_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: AppointmentRecord["status"];
  readonly source: AppointmentRecord["source"];
  readonly notes: string | null;
  readonly dedupe_fingerprint: string | null;
  readonly idempotency_key: string | null;
  readonly reminder_24h_sent_at: string | null;
  readonly created_at: string;
  readonly google_event_id: string | null;
  readonly google_sync_status: GoogleSyncStatus;
  readonly google_sync_attempts: number;
  readonly google_sync_next_retry_at: string | null;
  readonly google_sync_error: string | null;
}

function mapAppointment(row: AppointmentRow): AppointmentRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    customerId: row.customer_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    source: row.source,
    notes: row.notes,
    dedupeFingerprint: row.dedupe_fingerprint,
    idempotencyKey: row.idempotency_key,
    reminder24hSentAt: row.reminder_24h_sent_at,
    createdAt: row.created_at,
    googleEventId: row.google_event_id,
    googleSyncStatus: row.google_sync_status,
    googleSyncAttempts: row.google_sync_attempts,
    googleSyncNextRetryAt: row.google_sync_next_retry_at,
    googleSyncError: row.google_sync_error,
  };
}

interface ProviderCalendarAccountRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly google_calendar_id: string;
  readonly google_watch_channel_id: string | null;
  readonly google_watch_resource_id: string | null;
  readonly google_watch_expires_at: string | null;
  readonly sync_status: ProviderCalendarAccountRecord["syncStatus"];
  readonly sync_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function mapCalendarAccount(row: ProviderCalendarAccountRow): ProviderCalendarAccountRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    providerId: row.provider_id,
    googleCalendarId: row.google_calendar_id,
    googleWatchChannelId: row.google_watch_channel_id,
    googleWatchResourceId: row.google_watch_resource_id,
    googleWatchExpiresAt: row.google_watch_expires_at,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) -- bitácora de auditoría del staff, ver
// migrations/023_citas_audit_log.sql. REGLA DURA DE COMPATIBILIDAD CON LA BASE
// SIN MIGRAR (ver AGENTS.md de esta fase): mergear a `main` despliega el código
// al instante pero la base Supabase real va ~30 migraciones atrás -- nadie
// aplica esta migración al mergear. `citas.record_audit_log`/`citas.audit_log`
// no existen todavía en ese estado, y Postgres real lanza SQLSTATE 42883
// (`undefined_function`)/42P01 (`undefined_table`)/42703 (`undefined_column`)
// en ese caso -- `isMigrationPendingError` (@atiende/db) ya cubre el trío.
// ---------------------------------------------------------------------------
const CITAS_AUDIT_LOG_WRITE_SAVEPOINT = "sp_citas_audit_log_write";
const CITAS_AUDIT_LOG_READ_SAVEPOINT = "sp_citas_audit_log_read";

let auditLogAdvertidoEscritura = false;
function advertirCitasAuditLogEscrituraNoDisponible(err: unknown): void {
  if (auditLogAdvertidoEscritura) return;
  auditLogAdvertidoEscritura = true;
  console.warn(
    "PostgresCitasRepository.registrarAuditoria: citas.record_audit_log no existe todavía en esta base " +
      "(SQLSTATE 42883/42P01/42703) -- la acción de negocio YA se completó y no se revierte, esta fila de " +
      "bitácora se omitió. Aplica packages/domain-citas/migrations/023_citas_audit_log.sql (o su espejo " +
      "en supabase/migrations/) para habilitarla.",
    err,
  );
}

let auditLogAdvertidoLectura = false;
function advertirCitasAuditLogLecturaNoDisponible(err: unknown): void {
  if (auditLogAdvertidoLectura) return;
  auditLogAdvertidoLectura = true;
  console.warn(
    "PostgresCitasRepository.listAuditoria: citas.audit_log no existe todavía en esta base (SQLSTATE " +
      "42883/42P01/42703) -- devolviendo disponible:false (nunca una lista vacía real, ver CitasAuditLogPagina). " +
      "Aplica packages/domain-citas/migrations/023_citas_audit_log.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

interface CitasAuditLogRowSql {
  id: string;
  actor_user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  campo: string | null;
  antes: string | null;
  despues: string | null;
  created_at: string;
}

function mapCitasAuditLogRow(row: CitasAuditLogRowSql): CitasAuditLogRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    campo: row.campo,
    antes: row.antes,
    despues: row.despues,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}


// ---------------------------------------------------------------------------
// C-02 -- solicitudes de derechos ARCO (migrations/024_citas_data_rights.sql).
// Base SIN MIGRAR: la 024 no se aplica al mergear. Cada método corre en su propio
// SAVEPOINT (`runWithSavepointFallback`) y cae a "no disponible" con 42883/42P01/
// 42703 -- la sesión compartida del request/webhook nunca queda abortada (25P02).
// ---------------------------------------------------------------------------
let dataRightsAdvertido = false;
function advertirDataRightsNoDisponible(operacion: string, err: unknown): void {
  if (dataRightsAdvertido) return;
  dataRightsAdvertido = true;
  console.warn(
    `PostgresCitasRepository.${operacion}: las solicitudes ARCO (citas.data_rights_*) no existen todavía en esta base ` +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible'. Aplica packages/domain-citas/migrations/024_citas_data_rights.sql " +
      "(o su espejo en supabase/migrations/) para habilitarlas.",
    err instanceof Error ? err.message : err,
  );
}

interface DataRightsRequestRowSql {
  id: string;
  customer_phone: string;
  right_type: DataRightType;
  channel: "whatsapp" | "voice";
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

function mapDataRightsRequestRow(row: DataRightsRequestRowSql): DataRightsRequestRow {
  return {
    id: row.id,
    customerPhone: row.customer_phone,
    rightType: row.right_type,
    channel: row.channel,
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

// C-04 -- ver el bloque "mensajes de WhatsApp editables" de la clase.
interface WhatsappMessageConfigRowSql {
  reminder_enabled: boolean;
  reminder_text: string | null;
  reminder_lead_hours: number;
  confirmation_enabled: boolean;
  confirmation_text: string | null;
  cancellation_enabled: boolean;
  cancellation_text: string | null;
  reschedule_enabled: boolean;
  reschedule_text: string | null;
  send_window_start: number | null;
  send_window_end: number | null;
  // Solo vienen en la lectura del panel (la de envio no las devuelve).
  version: number;
  updated_by: string | null;
  updated_at: string;
}

function mapWhatsappMessageConfigRow(r: WhatsappMessageConfigRowSql): WhatsappMessageConfig {
  return {
    reminderEnabled: r.reminder_enabled,
    reminderText: r.reminder_text,
    reminderLeadHours: Number(r.reminder_lead_hours),
    confirmationEnabled: r.confirmation_enabled,
    confirmationText: r.confirmation_text,
    cancellationEnabled: r.cancellation_enabled,
    cancellationText: r.cancellation_text,
    rescheduleEnabled: r.reschedule_enabled,
    rescheduleText: r.reschedule_text,
    sendWindowStart: r.send_window_start === null ? null : Number(r.send_window_start),
    sendWindowEnd: r.send_window_end === null ? null : Number(r.send_window_end),
  };
}

const plantillasAdvertidas = new Set<string>();
function advertirPlantillasNoDisponibles(metodo: string, err: unknown): void {
  if (plantillasAdvertidas.has(metodo)) return;
  plantillasAdvertidas.add(metodo);
  console.warn(
    `PostgresCitasRepository.${metodo}: el catalogo de plantillas de WhatsApp y la ventana de 24 h (migracion 0050) no estan disponibles en esta base ` +
      "(SQLSTATE 42883/42P01/42703 o sin acceso) -- los avisos proactivos conservan el comportamiento anterior.",
    err instanceof Error ? err.message : err,
  );
}

const mensajesAdvertidos = new Set<string>();
function advertirMensajesNoDisponibles(metodo: string, err: unknown): void {
  if (mensajesAdvertidos.has(metodo)) return;
  mensajesAdvertidos.add(metodo);
  console.warn(
    `PostgresCitasRepository.${metodo}: la configuracion de mensajes de WhatsApp (migracion 026) no esta disponible en esta base ` +
      "(SQLSTATE 42883/42P01/42703 o sin acceso) -- se usan los textos y el horario de siempre.",
    err instanceof Error ? err.message : err,
  );
}

const agenteAdvertidos = new Set<string>();
function advertirAgenteNoDisponible(metodo: string, err: unknown): void {
  if (agenteAdvertidos.has(metodo)) return;
  agenteAdvertidos.add(metodo);
  console.warn(
    `PostgresCitasRepository.${metodo}: la personalidad del agente y la conexion del numero de WhatsApp (migracion 028) no estan disponibles en esta base ` +
      "(SQLSTATE 42883/42P01/42703 o sin acceso) -- el agente habla como siempre y la pantalla lo dice.",
    err instanceof Error ? err.message : err,
  );
}

/**
 * El horario ya no esta disponible: AT423 es el rechazo normal del `EXCLUDE` (la RPC lo lanza al perder la carrera) y 40P01 (deadlock_detected)
 * es el MISMO caso cuando dos reservas del mismo proveedor/horario se disparan al mismo tiempo. Cada transaccion inserta su fila y luego espera la
 * de la otra para comprobar el `EXCLUDE`; Postgres detecta el ciclo y aborta a una de las dos con 40P01 en vez de 23P01. La prueba real de
 * concurrencia (scripts/verify-citas-concurrencia, C-17) lo reprodujo al reagendar y crear a la vez: sin este mapeo, la que perdia la carrera
 * respondia un 500 en vez del 409 "horario no disponible". Nunca hay doble cita en ningun caso: la fila de la perdedora no se confirma.
 */
export function esConflictoDeHorario(code: unknown): boolean {
  return code === "AT423" || code === "40P01";
}

function sqlState(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

export class PostgresCitasRepository implements CitasRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const { rows } = await this.db.query<{ id: string; name: string; slug: string; status: "trial" | "active" | "suspended" }>(
      `select id, name, slug, status from core.organization where slug = $1 and vertical = 'citas';`,
      [slug],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, slug: row.slug, isActive: row.status === "active" } : null;
  }

  // Fase 5 §1 — `core.property` no tiene columna propia de vertical citas (a
  // diferencia de `restaurantes.branch_detail`, ver nota de diseño en
  // repository.ts) — se lee directo de `core.property`, sin join.
  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string }>(
      `select id as property_id, name from core.property where organization_id = $1 and status = 'active' order by name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name }));
  }

  async findPropertyTimezone(propertyId: string | null, organizationId: string): Promise<string> {
    if (propertyId) {
      const { rows } = await this.db.query<{ timezone: string }>(`select timezone from citas.property_config where property_id = $1;`, [propertyId]);
      if (rows[0]?.timezone) return rows[0].timezone;
    }
    const { rows } = await this.db.query<{ default_timezone: string }>(`select default_timezone from citas.tenant_config where organization_id = $1;`, [organizationId]);
    return rows[0]?.default_timezone ?? "America/Mexico_City";
  }

  async findProvider(organizationId: string, providerId: string): Promise<ProviderRecord | null> {
    const { rows } = await this.db.query<ProviderRow>(
      `select id, organization_id, property_id, display_name, role_label, is_active from citas.providers where id = $1 and organization_id = $2;`,
      [providerId, organizationId],
    );
    return rows[0] ? mapProvider(rows[0]) : null;
  }

  async findProvidersByIds(organizationId: string, providerIds: readonly string[]): Promise<readonly ProviderRecord[]> {
    if (providerIds.length === 0) return [];
    const { rows } = await this.db.query<ProviderRow>(
      `select id, organization_id, property_id, display_name, role_label, is_active from citas.providers where organization_id = $1 and id = ANY($2);`,
      [organizationId, providerIds],
    );
    return rows.map(mapProvider);
  }

  async findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null> {
    const { rows } = await this.db.query<ServiceRow>(
      `select id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active from citas.services where id = $1 and organization_id = $2;`,
      [serviceId, organizationId],
    );
    return rows[0] ? mapService(rows[0]) : null;
  }

  async findServicesByIds(organizationId: string, serviceIds: readonly string[]): Promise<readonly ServiceRecord[]> {
    if (serviceIds.length === 0) return [];
    const { rows } = await this.db.query<ServiceRow>(
      `select id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active from citas.services where organization_id = $1 and id = ANY($2);`,
      [organizationId, serviceIds],
    );
    return rows.map(mapService);
  }

  async providerOffersService(providerId: string, serviceId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ count: string }>(`select count(*)::text as count from citas.provider_services where provider_id = $1 and service_id = $2;`, [providerId, serviceId]);
    return Number(rows[0]?.count ?? "0") > 0;
  }

  // ---- Fase 8 — panel admin: CRUD real de proveedores/servicios (ver
  // repository.ts::NewProviderInput/ProviderPatch/NewServiceInput/ServicePatch para
  // el porqué de cada campo). Mismo patrón `coalesce`/`case when $n::boolean` que
  // `updateProduct` de domain-restaurantes (postgres-repository.ts) para distinguir
  // "campo ausente del patch" (deja la columna intacta) de "campo presente pero
  // null" (sí escribe null) en `property_id`/`price_cents`. ----
  async createProvider(input: NewProviderInput): Promise<ProviderRecord> {
    const { rows } = await this.db.query<ProviderRow>(
      `insert into citas.providers (organization_id, property_id, display_name, role_label, is_active)
       values ($1, $2, $3, $4, $5)
       returning id, organization_id, property_id, display_name, role_label, is_active;`,
      [input.organizationId, input.propertyId ?? null, input.displayName, input.roleLabel ?? "Proveedor", input.isActive ?? true],
    );
    return mapProvider(rows[0]!);
  }

  async updateProvider(organizationId: string, providerId: string, patch: ProviderPatch): Promise<ProviderRecord | null> {
    const { rows } = await this.db.query<ProviderRow>(
      `update citas.providers
       set display_name = coalesce($3, display_name),
           role_label = coalesce($4, role_label),
           property_id = case when $5::boolean then $6::uuid else property_id end,
           is_active = coalesce($7, is_active),
           updated_at = now()
       where id = $1 and organization_id = $2
       returning id, organization_id, property_id, display_name, role_label, is_active;`,
      [providerId, organizationId, patch.displayName ?? null, patch.roleLabel ?? null, patch.propertyId !== undefined, patch.propertyId ?? null, patch.isActive ?? null],
    );
    return rows[0] ? mapProvider(rows[0]) : null;
  }

  async setProviderServiceOffering(providerId: string, serviceId: string, offered: boolean): Promise<void> {
    if (offered) {
      await this.db.query(`insert into citas.provider_services (provider_id, service_id) values ($1, $2) on conflict (provider_id, service_id) do nothing;`, [providerId, serviceId]);
    } else {
      await this.db.query(`delete from citas.provider_services where provider_id = $1 and service_id = $2;`, [providerId, serviceId]);
    }
  }

  async createService(input: NewServiceInput): Promise<ServiceRecord> {
    const { rows } = await this.db.query<ServiceRow>(
      `insert into citas.services (organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active;`,
      [input.organizationId, input.name, input.durationMinutes, input.bufferMinutesBefore ?? 0, input.bufferMinutesAfter ?? 0, input.priceCents ?? null, input.isActive ?? true],
    );
    return mapService(rows[0]!);
  }

  async updateService(organizationId: string, serviceId: string, patch: ServicePatch): Promise<ServiceRecord | null> {
    const { rows } = await this.db.query<ServiceRow>(
      `update citas.services
       set name = coalesce($3, name),
           duration_minutes = coalesce($4, duration_minutes),
           buffer_minutes_before = coalesce($5, buffer_minutes_before),
           buffer_minutes_after = coalesce($6, buffer_minutes_after),
           price_cents = case when $7::boolean then $8::integer else price_cents end,
           is_active = coalesce($9, is_active),
           updated_at = now()
       where id = $1 and organization_id = $2
       returning id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active;`,
      [
        serviceId,
        organizationId,
        patch.name ?? null,
        patch.durationMinutes ?? null,
        patch.bufferMinutesBefore ?? null,
        patch.bufferMinutesAfter ?? null,
        patch.priceCents !== undefined,
        patch.priceCents ?? null,
        patch.isActive ?? null,
      ],
    );
    return rows[0] ? mapService(rows[0]) : null;
  }

  async loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]> {
    const { rows } = await this.db.query<AvailabilityRuleRow>(
      `select id, provider_id, day_of_week, start_time, end_time, is_active from citas.availability_rules where provider_id = $1 order by day_of_week, start_time;`,
      [providerId],
    );
    return rows.map(mapAvailabilityRule);
  }

  async loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null> {
    const { rows } = await this.db.query<AvailabilityOverrideRow>(
      `select provider_id, override_date, is_closed, start_time, end_time, reason from citas.availability_overrides where provider_id = $1 and override_date = $2;`,
      [providerId, dateStr],
    );
    const row = rows[0];
    return row ? mapAvailabilityOverride(row) : null;
  }

  async listAvailabilityOverrides(providerId: string, fromDateInclusive?: string): Promise<readonly AvailabilityOverride[]> {
    const { rows } = await this.db.query<AvailabilityOverrideRow>(
      fromDateInclusive
        ? `select provider_id, override_date, is_closed, start_time, end_time, reason from citas.availability_overrides where provider_id = $1 and override_date >= $2 order by override_date;`
        : `select provider_id, override_date, is_closed, start_time, end_time, reason from citas.availability_overrides where provider_id = $1 order by override_date;`,
      fromDateInclusive ? [providerId, fromDateInclusive] : [providerId],
    );
    return rows.map(mapAvailabilityOverride);
  }

  // ---- Fase 10 — panel admin: CRUD real de horarios/excepciones (ver diseño Fase
  // 10 §1/§2, repository.ts::NewAvailabilityRuleInput/AvailabilityRulePatch/
  // AvailabilityOverrideInput para el porqué de cada campo). ----
  async createAvailabilityRule(input: NewAvailabilityRuleInput): Promise<AvailabilityRule> {
    const { rows } = await this.db.query<AvailabilityRuleRow>(
      `insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time, is_active)
       values ($1, $2, $3, $4, $5)
       returning id, provider_id, day_of_week, start_time, end_time, is_active;`,
      [input.providerId, input.dayOfWeek, input.startTime, input.endTime, input.isActive ?? true],
    );
    return mapAvailabilityRule(rows[0]!);
  }

  async updateAvailabilityRule(providerId: string, ruleId: string, patch: AvailabilityRulePatch): Promise<AvailabilityRule | null> {
    const { rows } = await this.db.query<AvailabilityRuleRow>(
      `update citas.availability_rules
       set day_of_week = coalesce($3, day_of_week),
           start_time = coalesce($4, start_time),
           end_time = coalesce($5, end_time),
           is_active = coalesce($6, is_active)
       where id = $1 and provider_id = $2
       returning id, provider_id, day_of_week, start_time, end_time, is_active;`,
      [ruleId, providerId, patch.dayOfWeek ?? null, patch.startTime ?? null, patch.endTime ?? null, patch.isActive ?? null],
    );
    return rows[0] ? mapAvailabilityRule(rows[0]) : null;
  }

  async deleteAvailabilityRule(providerId: string, ruleId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(`delete from citas.availability_rules where id = $1 and provider_id = $2 returning id;`, [ruleId, providerId]);
    return rows.length > 0;
  }

  async upsertAvailabilityOverride(input: AvailabilityOverrideInput): Promise<AvailabilityOverride> {
    const startTime = input.isClosed ? null : (input.startTime ?? null);
    const endTime = input.isClosed ? null : (input.endTime ?? null);
    const { rows } = await this.db.query<AvailabilityOverrideRow>(
      `insert into citas.availability_overrides (provider_id, override_date, is_closed, start_time, end_time, reason)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (provider_id, override_date) do update
         set is_closed = excluded.is_closed, start_time = excluded.start_time, end_time = excluded.end_time, reason = excluded.reason
       returning provider_id, override_date, is_closed, start_time, end_time, reason;`,
      [input.providerId, input.overrideDate, input.isClosed, startTime, endTime, input.reason ?? null],
    );
    return mapAvailabilityOverride(rows[0]!);
  }

  async deleteAvailabilityOverride(providerId: string, overrideDate: string): Promise<boolean> {
    const { rows } = await this.db.query<{ provider_id: string }>(
      `delete from citas.availability_overrides where provider_id = $1 and override_date = $2 returning provider_id;`,
      [providerId, overrideDate],
    );
    return rows.length > 0;
  }

  async loadBusyIntervals(providerId: string, dayStartUtc: string, dayEndUtc: string, excludeAppointmentId?: string): Promise<readonly BusyInterval[]> {
    const { rows } = await this.db.query<{ id: string; starts_at: string; ends_at: string }>(
      `select id, starts_at, ends_at from citas.appointments
       where provider_id = $1 and status in ('pending','confirmed','completed')
         and starts_at < $3 and ends_at > $2
         and ($4::uuid is null or id <> $4::uuid);`,
      [providerId, dayStartUtc, dayEndUtc, excludeAppointmentId ?? null],
    );
    return rows.map((r) => ({ start: new Date(r.starts_at), end: new Date(r.ends_at) }));
  }

  async upsertCustomer(organizationId: string, phone: string, name: string, email?: string | null, options: UpsertCustomerOptions = {}): Promise<CustomerRecord> {
    const { rows: existingRows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      if (!email || options.emailOnlyIfNew) return { id: existing.id, organizationId: existing.organization_id, fullName: existing.full_name, phone: existing.phone, email: existing.email };
      const { rows: updated } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `update citas.customers set email = coalesce(email, $3), updated_at = now() where id = $1 and organization_id = $2 returning id, organization_id, full_name, phone, email;`,
        [existing.id, organizationId, email],
      );
      const row = updated[0] ?? existing;
      return { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email };
    }
    // Fix hallazgo auditoría (rubro 3, "recuperación de 23505 sin SAVEPOINT deriva en
    // 25P02") — sin este SAVEPOINT, el unique_violation de abajo deja TODA la
    // transacción de la request en curso abortada a nivel Postgres (25P02:
    // "current transaction is aborted, commands ignored until end of transaction
    // block") y el SELECT de recuperación fallaría también, en vez de devolver la
    // fila ganadora — mismo patrón ya establecido en
    // domain-rentas/src/aplicacion/reservas.ts (`crearReservaConfirmada`).
    await this.db.exec("SAVEPOINT sp_upsert_customer_race");
    try {
      const { rows: created } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `insert into citas.customers (organization_id, phone, full_name, email) values ($1, $2, $3, $4) returning id, organization_id, full_name, phone, email;`,
        [organizationId, phone, name, email ?? null],
      );
      await this.db.exec("RELEASE SAVEPOINT sp_upsert_customer_race");
      const row = created[0]!;
      return { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email };
    } catch (err) {
      // Carrera real entre dos requests casi simultáneas del mismo cliente nuevo: el
      // UNIQUE(organization_id, phone) rechaza el segundo INSERT — se recupera en
      // vez de propagar un error genérico (mismo patrón que domain-restaurantes).
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      await this.db.exec("ROLLBACK TO SAVEPOINT sp_upsert_customer_race");
      await this.db.exec("RELEASE SAVEPOINT sp_upsert_customer_race");
      const { rows: race } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and phone = $2;`,
        [organizationId, phone],
      );
      const winner = race[0];
      if (!winner) throw err;
      return { id: winner.id, organizationId: winner.organization_id, fullName: winner.full_name, phone: winner.phone, email: winner.email };
    }
  }

  async findCustomerByPhone(organizationId: string, phone: string): Promise<CustomerRecord | null> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    const row = rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email } : null;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<CustomerRecord | null> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and id = $2;`,
      [organizationId, customerId],
    );
    const row = rows[0];
    return row ? { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email } : null;
  }

  async findCustomersByIds(organizationId: string, customerIds: readonly string[]): Promise<readonly CustomerRecord[]> {
    if (customerIds.length === 0) return [];
    const { rows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and id = ANY($2);`,
      [organizationId, customerIds],
    );
    return rows.map((row) => ({ id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email }));
  }

  async countAppointmentsByStatus(organizationId: string, fromIso: string, toIso: string): Promise<Readonly<Record<AppointmentStatus, number>>> {
    const { rows } = await this.db.query<{ status: AppointmentStatus; count: string }>(
      `select status, count(*)::text as count from citas.appointments where organization_id = $1 and starts_at >= $2 and starts_at < $3 group by status;`,
      [organizationId, fromIso, toIso],
    );
    const result: Record<AppointmentStatus, number> = { pending: 0, confirmed: 0, completed: 0, cancelled: 0, no_show: 0 };
    for (const row of rows) if (row.status in result) result[row.status] = Number(row.count);
    return result;
  }

  async countAppointmentsCreatedBySource(organizationId: string, sinceIso: string): Promise<Readonly<Record<AppointmentSource, number>>> {
    const { rows } = await this.db.query<{ source: AppointmentSource; count: string }>(
      `select source, count(*)::text as count from citas.appointments where organization_id = $1 and created_at >= $2 and status <> 'cancelled' group by source;`,
      [organizationId, sinceIso],
    );
    const result: Record<AppointmentSource, number> = { voice: 0, whatsapp: 0, web: 0, manual: 0 };
    for (const row of rows) if (row.source in result) result[row.source] = Number(row.count);
    return result;
  }

  async countCustomersCreatedSince(organizationId: string, sinceIso: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(`select count(*)::text as count from citas.customers where organization_id = $1 and created_at >= $2;`, [organizationId, sinceIso]);
    return Number(rows[0]?.count ?? "0");
  }

  async listCustomers(organizationId: string, opts: { readonly limit: number; readonly offset: number; readonly search?: string }): Promise<CustomerPage> {
    const search = opts.search?.trim();
    const searchPattern = search ? `%${search}%` : null;
    const { rows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null; total: string }>(
      `select id, organization_id, full_name, phone, email, count(*) over ()::text as total
       from citas.customers
       where organization_id = $1
         and ($2::text is null or full_name ilike $2 or phone ilike $2)
       order by full_name asc
       limit $3 offset $4;`,
      [organizationId, searchPattern, opts.limit, opts.offset],
    );
    const items = rows.map((row) => ({ id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email }));
    const total = rows[0] ? Number(rows[0].total) : 0;
    const nextOffset = opts.offset + items.length < total ? opts.offset + items.length : null;
    return { items, total, nextOffset };
  }

  /** Fase 6 §2 (seguimiento) — `citas.customers` solo tiene policy RLS de SELECT
   * para `authenticated` (ver 001_citas_schema.sql); igual que crear una cita
   * desde el panel, la escritura pasa por una RPC `security definer` que verifica
   * membership de organización ANTES de tocar la fila (`update_customer_email_
   * from_panel`, ver migrations/019). */
  async updateCustomerEmailFromPanel(organizationId: string, customerId: string, email: string | null): Promise<CustomerRecord | null> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select citas.update_customer_email_from_panel($1, $2, $3) as result;`,
      [organizationId, customerId, email],
    );
    const result = (rows[0] as unknown as { result: { id: string; organization_id: string; full_name: string; phone: string; email: string | null } | null } | undefined)?.result;
    return result ? { id: result.id, organizationId: result.organization_id, fullName: result.full_name, phone: result.phone, email: result.email } : null;
  }

  async listActiveServices(organizationId: string): Promise<readonly ServiceRecord[]> {
    const { rows } = await this.db.query<ServiceRow>(
      `select id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active
       from citas.services where organization_id = $1 and is_active = true order by name asc;`,
      [organizationId],
    );
    return rows.map(mapService);
  }

  async listActiveProviders(organizationId: string, serviceId?: string): Promise<readonly ProviderRecord[]> {
    if (serviceId) {
      const { rows } = await this.db.query<ProviderRow>(
        `select p.id, p.organization_id, p.property_id, p.display_name, p.role_label, p.is_active
         from citas.providers p
         join citas.provider_services ps on ps.provider_id = p.id
         where p.organization_id = $1 and p.is_active = true and ps.service_id = $2
         order by p.display_name asc;`,
        [organizationId, serviceId],
      );
      return rows.map(mapProvider);
    }
    const { rows } = await this.db.query<ProviderRow>(
      `select id, organization_id, property_id, display_name, role_label, is_active
       from citas.providers where organization_id = $1 and is_active = true order by display_name asc;`,
      [organizationId],
    );
    return rows.map(mapProvider);
  }

  async listActiveAppointmentsForCustomer(organizationId: string, customerId: string, nowIso: string): Promise<readonly AppointmentRecord[]> {
    const { rows } = await this.db.query<AppointmentRow>(
      `select id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, dedupe_fingerprint, idempotency_key, reminder_24h_sent_at, created_at, google_event_id, google_sync_status, google_sync_attempts, google_sync_next_retry_at, google_sync_error
       from citas.appointments
       where organization_id = $1 and customer_id = $2 and status in ('pending','confirmed') and starts_at >= $3
       order by starts_at asc;`,
      [organizationId, customerId, nowIso],
    );
    return rows.map(mapAppointment);
  }

  // NOTA (bloqueante r3, re-revisión PR #158): el RPC va envuelto en
  // `runWithRowSavepoint` -- si `citas.create_appointment_idempotent` lanza
  // AT423/AT409, Postgres deja la transacción del request ABORTADA (RAISE dentro de
  // una función SQL, no algo que un `catch` de JS pueda deshacer). Sin el SAVEPOINT,
  // el catch de abajo mapea el error a un resultado discriminado normal, pero la
  // sesión SIGUE abortada: cualquier caller que reutilice `db` después (o el
  // `COMMIT` final de `withAppSession`) revienta con 25P02/`AbortedTransactionCommit
  // Error`. `runWithRowSavepoint` hace `ROLLBACK TO SAVEPOINT` ANTES de que el error
  // llegue a este catch, así que cuando el catch mapea AT423/AT409, la sesión ya está
  // utilizable de nuevo.
  async createAppointmentIdempotent(input: NewAppointmentInput, dedupeFingerprint: string, idempotencyKey: string | null): Promise<CreateAppointmentResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ create_appointment_idempotent: AppointmentRow }>(`select citas.create_appointment_idempotent($1::jsonb, $2, $3) as create_appointment_idempotent;`, [
          JSON.stringify({
            organization_id: input.organizationId,
            property_id: input.propertyId,
            provider_id: input.providerId,
            service_id: input.serviceId,
            customer_id: input.customerId,
            starts_at: input.startsAt,
            ends_at: input.endsAt,
            status: input.status,
            source: input.source,
            notes: input.notes,
          }),
          dedupeFingerprint,
          idempotencyKey,
        ]),
      );
      const cita = mapAppointment(rows[0]!.create_appointment_idempotent);
      // Notificacion in-app (productor compartido, `citas.cita.nueva`): una cita agendada por un CANAL (agente de voz/WhatsApp o agenda
      // publica) es "algo nuevo que atender". Una por cita (clave = id: un reintento idempotente que devuelve la misma cita no vuelve a
      // avisar), sin PII (titulo del catalogo), acotada a quienes ven la sucursal de la cita. Las capturadas a mano (`manual`) no avisan.
      // SAVEPOINT en emitirNotificacion: contra la base sin migrar no aborta la transaccion del request.
      if (cita.source !== "manual") {
        await emitirNotificacion(this.db, { evento: "citas.cita.nueva", organizationId: cita.organizationId, propertyId: cita.propertyId, clave: cita.id, entidadTipo: "appointment", entidadId: cita.id });
      }
      return { outcome: "created", appointment: cita };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (esConflictoDeHorario(code)) return { outcome: "conflict_slot_taken" };
      if (code === "AT409") return { outcome: "conflict_idempotency_reused" };
      throw err;
    }
  }

  async findAppointmentForOrganization(organizationId: string, appointmentId: string): Promise<AppointmentRecord | null> {
    const { rows } = await this.db.query<AppointmentRow>(
      `select id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, dedupe_fingerprint, idempotency_key, reminder_24h_sent_at, created_at, google_event_id, google_sync_status, google_sync_attempts, google_sync_next_retry_at, google_sync_error
       from citas.appointments where id = $1 and organization_id = $2;`,
      [appointmentId, organizationId],
    );
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  async listAppointmentsInRange(organizationId: string, fromIso: string, toIso: string, providerId: string | undefined, limit: number): Promise<readonly AppointmentRecord[]> {
    const { rows } = await this.db.query<AppointmentRow>(
      `select id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, dedupe_fingerprint, idempotency_key, reminder_24h_sent_at, created_at, google_event_id, google_sync_status, google_sync_attempts, google_sync_next_retry_at, google_sync_error
       from citas.appointments
       where organization_id = $1 and starts_at >= $2 and starts_at < $3
         and ($4::uuid is null or provider_id = $4)
       order by starts_at asc
       limit $5;`,
      [organizationId, fromIso, toIso, providerId ?? null, limit],
    );
    return rows.map(mapAppointment);
  }

  // NOTA (bloqueante r3): mismo argumento que `createAppointmentIdempotent` de
  // arriba -- `runWithRowSavepoint` alrededor del RPC para que el catch de abajo
  // mapee AT404/AT409/AT403 sobre una sesión ya recuperada, no una abortada.
  private async runCancelRpc(fn: "cancel_appointment_idempotent" | "cancel_appointment_from_panel", organizationId: string, appointmentId: string): Promise<CancelResult> {
    // `cancel_appointment_idempotent` devuelve la fila tal cual cuando YA estaba cancelada (no-op), asi que el resultado no distingue
    // "la cancele ahora" de "ya estaba cancelada": se lee el estado previo (misma sesion, en secuencia) para avisar solo lo primero.
    const estabaCancelada = fn === "cancel_appointment_idempotent" ? (await this.findAppointmentForOrganization(organizationId, appointmentId))?.status === "cancelled" : false;
    try {
      const { rows } = await this.runWithRowSavepoint(() => this.db.query<{ [key: string]: AppointmentRow }>(`select citas.${fn}($1, $2) as result;`, [organizationId, appointmentId]));
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      // Notificacion in-app (`citas.cita.cancelada`): SOLO cuando la cancelacion la hace el cliente/agente (RPC de sistema), no cuando la
      // hace el propio staff desde el panel; una por cita cancelada (clave = id) y solo si ESTA llamada la cancelo (un reintento sobre una
      // cita ya cancelada no reemite, ni siquiera pasada la vigencia de la dedupe).
      if (fn === "cancel_appointment_idempotent" && appointment.status === "cancelled" && !estabaCancelada) {
        await emitirNotificacion(this.db, { evento: "citas.cita.cancelada", organizationId: appointment.organizationId, propertyId: appointment.propertyId, clave: appointment.id, entidadTipo: "appointment", entidadId: appointment.id });
      }
      return { outcome: appointment.status === "cancelled" ? "cancelled" : "already_cancelled", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "completed" };
      // Fase 12 -- solo `cancel_appointment_from_panel` puede lanzar AT403 (staff
      // fuera del alcance de sucursal de ESTA cita, ver migrations/015 y
      // errors.ts::AppointmentForbiddenError); `cancel_appointment_idempotent`
      // (agente, sesión de sistema sin auth.uid() de staff) nunca lo lanza -- esta
      // rama queda inerte para esa RPC, sin cambiar su comportamiento.
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  async cancelAppointmentIdempotent(organizationId: string, appointmentId: string): Promise<CancelResult> {
    return this.runCancelRpc("cancel_appointment_idempotent", organizationId, appointmentId);
  }

  async cancelAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<CancelResult> {
    return this.runCancelRpc("cancel_appointment_from_panel", organizationId, appointmentId);
  }

  // ---- Fase 7 -- confirmar/completar/marcar no-show desde el panel de staff
  // (migrations/010_appointment_status_transitions.sql). Mismo patrón EXACTO que
  // runCancelRpc: RPC atómica real, AT404/AT409 mapeados a valores discriminados,
  // nunca excepciones crudas de Postgres saliendo del adaptador. ----

  // NOTA (bloqueante r3): mismo argumento -- `runWithRowSavepoint` alrededor del RPC.
  async confirmAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<ConfirmResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() => this.db.query<{ result: AppointmentRow }>(`select citas.confirm_appointment_from_panel($1, $2) as result;`, [organizationId, appointmentId]));
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      return { outcome: appointment.status === "confirmed" ? "confirmed" : "already_confirmed", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "completed" };
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  /** C-01 -- ver `CitasRepository.confirmAppointmentByCustomerAsSystem` y la migración
   * `025_citas_confirmacion_por_boton.sql`. Corre en la ÚNICA transacción del request
   * del webhook: `runWithSavepointFallback` aísla CUALQUIER error esperable de la
   * función (migración pendiente 42883/42P01/42703 y los de negocio AT404/AT409/
   * 42501) dentro de un SAVEPOINT, así que la sesión queda utilizable para lo que el
   * turno haga después (responder, encolar el outbox) en vez de abortada (25P02). */
  async confirmAppointmentByCustomerAsSystem(organizationId: string, appointmentId: string, customerPhone: string): Promise<CustomerConfirmResult> {
    return runWithSavepointFallback<CustomerConfirmResult>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ result: AppointmentRow }>(`select citas.system_confirm_appointment_by_customer($1, $2, $3) as result;`, [organizationId, appointmentId, customerPhone]);
        const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
        return { outcome: appointment.status === "confirmed" ? "confirmed" : "already_confirmed", appointment };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.system_confirm_appointment_by_customer") || ["AT404", "AT409"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        switch (sqlState(err)) {
          case "AT404":
            return Promise.resolve({ outcome: "not_found" });
          case "AT409":
            return Promise.resolve({ outcome: "conflict_invalid_status", status: "no_confirmable" });
          default:
            console.warn(
              "PostgresCitasRepository.confirmAppointmentByCustomerAsSystem: citas.system_confirm_appointment_by_customer no existe todavía en esta base " +
                "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible'. Aplica packages/domain-citas/migrations/025_citas_confirmacion_por_boton.sql (o su espejo en supabase/migrations/).",
              err instanceof Error ? err.message : err,
            );
            return Promise.resolve({ outcome: "unavailable" });
        }
      },
    });
  }

  // NOTA (bloqueante r3): mismo argumento -- `runWithRowSavepoint` alrededor del RPC.
  async completeAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<CompleteResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() => this.db.query<{ result: AppointmentRow }>(`select citas.complete_appointment_from_panel($1, $2) as result;`, [organizationId, appointmentId]));
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      return { outcome: appointment.status === "completed" ? "completed" : "already_completed", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "cancelled" };
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  // NOTA (bloqueante r3): mismo argumento -- `runWithRowSavepoint` alrededor del RPC.
  async markAppointmentNoShowFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<NoShowResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() => this.db.query<{ result: AppointmentRow }>(`select citas.mark_appointment_no_show_from_panel($1, $2) as result;`, [organizationId, appointmentId]));
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      return { outcome: appointment.status === "no_show" ? "marked_no_show" : "already_no_show", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "cancelled" };
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  // ---- Fase 12 -- alta real de una cita desde el panel de staff (hallazgo de
  // auditoría ALTO, "Staff no puede crear citas manualmente desde la Agenda"), ver
  // CreateFromPanelResult/migrations/015. Sin dedupe (acción deliberada de un
  // humano, no un canal reintentable) -- el único invariante real es el EXCLUDE
  // using gist (AT423 -> conflict_slot_taken), mismo mapeo que
  // createAppointmentIdempotent de arriba.
  // NOTA (bloqueante r3): mismo argumento -- `runWithRowSavepoint` alrededor del RPC.
  async createAppointmentFromPanel(input: NewAppointmentFromPanelInput): Promise<CreateFromPanelResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ result: AppointmentRow }>(`select citas.create_appointment_from_panel($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result;`, [
          input.organizationId,
          input.propertyId,
          input.providerId,
          input.serviceId,
          input.customerName,
          input.customerPhone,
          input.customerEmail,
          input.startsAt,
          input.endsAt,
          input.notes,
        ]),
      );
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      return { outcome: "created", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (esConflictoDeHorario(code)) return { outcome: "conflict_slot_taken" };
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  // BLOQUEANTE re-revisión PR #158 (r3, ronda 2 de auditoría): regresión 409 -> 500
  // real en `POST /v1/citas/:orgSlug/appointments/:appointmentId/reschedule`
  // (`apps/api/.../appointments-lifecycle.ts`, sesión propia de `withAppSession`).
  // En una carrera real de horario, `citas.reschedule_appointment_idempotent` lanza
  // AT423 -- sin SAVEPOINT, el catch de abajo mapeaba el error a un resultado
  // discriminado normal (`conflict_slot_taken`), pero dejaba la sesión ABORTADA;
  // `appointments.ts::rescheduleAppointment` entonces llamaba a
  // `computeAlternativeSlots`, cuyas consultas fallaban con 25P02 y su catch-all
  // devolvía `[]` (alternativas vacías); `mapErrorToHttp` respondía 409 igual, pero
  // el `COMMIT` final de la sesión (todavía abortada) disparaba
  // `AbortedTransactionCommitError` -- 500 a un caller ACTUAL, no futuro. Con
  // `runWithRowSavepoint` alrededor del RPC, la sesión queda recuperada ANTES de que
  // este catch mapee AT423, así que `computeAlternativeSlots` corre sobre una sesión
  // sana y devuelve alternativas REALES, y el `COMMIT` final sí tiene éxito (409 con
  // alternativas, nunca 500). Mismo patrón en `reassignAppointmentIdempotent` abajo.
  async rescheduleAppointmentIdempotent(organizationId: string, appointmentId: string, newStartsAt: string, newEndsAt: string, actorChannel: AppointmentActorChannel, actorNote: string | null): Promise<RescheduleResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ reschedule_appointment_idempotent: AppointmentRow }>(`select citas.reschedule_appointment_idempotent($1, $2, $3, $4, $5, $6) as reschedule_appointment_idempotent;`, [
          organizationId,
          appointmentId,
          newStartsAt,
          newEndsAt,
          actorChannel,
          actorNote,
        ]),
      );
      return { outcome: "rescheduled", appointment: mapAppointment(rows[0]!.reschedule_appointment_idempotent) };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (esConflictoDeHorario(code)) return { outcome: "conflict_slot_taken" };
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "completed" };
      throw err;
    }
  }

  // NOTA (bloqueante r3): mismo argumento que `rescheduleAppointmentIdempotent` de
  // arriba -- `runWithRowSavepoint` alrededor del RPC.
  async reassignAppointmentIdempotent(organizationId: string, appointmentId: string, newProviderId: string, newServiceId: string, newEndsAt: string, actorChannel: AppointmentActorChannel, actorNote: string | null): Promise<ReassignResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ reassign_appointment_idempotent: AppointmentRow }>(`select citas.reassign_appointment_idempotent($1, $2, $3, $4, $5, $6, $7) as reassign_appointment_idempotent;`, [
          organizationId,
          appointmentId,
          newProviderId,
          newServiceId,
          newEndsAt,
          actorChannel,
          actorNote,
        ]),
      );
      return { outcome: "reassigned", appointment: mapAppointment(rows[0]!.reassign_appointment_idempotent) };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (esConflictoDeHorario(code)) return { outcome: "conflict_slot_taken" };
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "completed" };
      throw err;
    }
  }

  async listActiveOrganizations(): Promise<readonly { id: string; timezone: string }[]> {
    const { rows } = await this.db.query<{ id: string; default_timezone: string }>(
      `select o.id, tc.default_timezone from core.organization o
       join citas.tenant_config tc on tc.organization_id = o.id
       where o.vertical = 'citas' and o.status = 'active';`,
    );
    return rows.map((r) => ({ id: r.id, timezone: r.default_timezone }));
  }

  async loadAppointmentsPendingReminder(organizationId: string, windowStartIso: string, windowEndIso: string): Promise<readonly ReminderCandidateRow[]> {
    const { rows } = await this.db.query<{ appointment_id: string; provider_id: string; service_id: string | null; starts_at: string; created_at: string | null; customer_name: string | null; customer_phone: string }>(
      `select a.id as appointment_id, a.provider_id, a.service_id, a.starts_at, a.created_at, c.full_name as customer_name, c.phone as customer_phone
       from citas.appointments a
       join citas.customers c on c.id = a.customer_id
       where a.organization_id = $1 and a.status in ('pending','confirmed')
         and a.reminder_24h_sent_at is null
         and a.starts_at >= $2 and a.starts_at <= $3;`,
      [organizationId, windowStartIso, windowEndIso],
    );
    return rows.map((r) => ({ appointmentId: r.appointment_id, providerId: r.provider_id, startsAt: r.starts_at, customerName: r.customer_name, customerPhone: r.customer_phone, serviceId: r.service_id, createdAt: r.created_at }));
  }

  // ============================================================================
  // C-04 -- mensajes de WhatsApp editables, ver migrations/026_citas_whatsapp_mensajes_config.sql. REGLA DURA DE
  // COMPATIBILIDAD CON LA BASE SIN MIGRAR: mergear despliega el codigo pero nadie aplica la migracion. Cada metodo corre bajo
  // `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque la sesion es UNA transaccion por request: un
  // SQLSTATE 42883/42P01/42703 sin savepoint la dejaria abortada (25P02) y el COMMIT revertiria el trabajo del request.
  // ============================================================================

  async getWhatsappMessageConfig(organizationId: string): Promise<{ readonly disponible: boolean; readonly record: WhatsappMessageConfigRecord | null }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly record: WhatsappMessageConfigRecord | null }>({
      session: this.db,
      savepointName: "sp_citas_wa_msg_config_read",
      primary: async () => {
        const { rows } = await this.db.query<WhatsappMessageConfigRowSql>(
          `select reminder_enabled, reminder_text, reminder_lead_hours, confirmation_enabled, confirmation_text, cancellation_enabled,
                  cancellation_text, reschedule_enabled, reschedule_text, send_window_start, send_window_end, version, updated_by,
                  updated_at::text as updated_at
             from citas.whatsapp_message_config where organization_id = $1;`,
          [organizationId],
        );
        const row = rows[0];
        if (!row) return { disponible: true, record: null };
        return { disponible: true, record: { config: mapWhatsappMessageConfigRow(row), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by } };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirMensajesNoDisponibles("getWhatsappMessageConfig", err);
        return Promise.resolve({ disponible: false, record: null });
      },
    });
  }

  async getWhatsappMessageConfigForSend(organizationId: string): Promise<WhatsappMessageConfig | null> {
    return runWithSavepointFallback<WhatsappMessageConfig | null>({
      session: this.db,
      savepointName: "sp_citas_wa_msg_config_send",
      primary: async () => {
        const { rows } = await this.db.query<WhatsappMessageConfigRowSql>(`select * from citas.whatsapp_message_config_envio($1);`, [organizationId]);
        return rows[0] ? mapWhatsappMessageConfigRow(rows[0]) : null;
      },
      // 42501: una sesion de staff de OTRA organizacion pidio esta configuracion -- sin acceso se actua como "sin configuracion".
      isRecoverable: (err) => isMigrationPendingError(err, "citas.whatsapp_message_config_envio") || sqlState(err) === "42501",
      fallback: (err) => {
        advertirMensajesNoDisponibles("getWhatsappMessageConfigForSend", err);
        return Promise.resolve(null);
      },
    });
  }

  async listWhatsappTemplates(organizationId: string): Promise<{ readonly disponible: boolean; readonly items: readonly PlantillaWhatsappRecord[] }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly items: readonly PlantillaWhatsappRecord[] }>({
      session: this.db,
      savepointName: "sp_citas_wa_templates_list",
      primary: async () => {
        const { rows } = await this.db.query<{ evento: string; nombre: string; idioma: string; variables: string[]; estado: PlantillaWhatsappRecord["estado"]; aprobada_en: Date | string | null; updated_at: Date | string }>(
          `select evento, nombre, idioma, variables, estado, aprobada_en, updated_at from core.whatsapp_plantilla where organization_id = $1 and vertical = 'citas' order by evento;`,
          [organizationId],
        );
        const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
        return { disponible: true, items: rows.map((r) => ({ evento: r.evento, nombre: r.nombre, idioma: r.idioma, variables: r.variables, estado: r.estado, aprobadaEn: r.aprobada_en === null ? null : iso(r.aprobada_en), actualizadaEn: iso(r.updated_at) })) };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: (err) => {
        advertirPlantillasNoDisponibles("listWhatsappTemplates", err);
        return Promise.resolve({ disponible: false, items: [] });
      },
    });
  }

  async saveWhatsappTemplate(organizationId: string, evento: string, valor: PlantillaWhatsappInput): Promise<"saved" | "forbidden" | "unavailable"> {
    return runWithSavepointFallback<"saved" | "forbidden" | "unavailable">({
      session: this.db,
      savepointName: "sp_citas_wa_templates_save",
      primary: async () => {
        // creado_por = auth.uid(): la policy de INSERT lo exige y solo un owner/admin de la organizacion pasa el WITH CHECK (42501 si no).
        await this.db.query(
          `insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado, creado_por)
           values ($1, 'citas', $2, $3, $4, $5::text[], $6, auth.uid())
           on conflict (organization_id, vertical, evento) do update set nombre = excluded.nombre, idioma = excluded.idioma, variables = excluded.variables, estado = excluded.estado;`,
          [organizationId, evento, valor.nombre, valor.idioma, valor.variables, valor.estado],
        );
        return "saved";
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve("forbidden");
        advertirPlantillasNoDisponibles("saveWhatsappTemplate", err);
        return Promise.resolve("unavailable");
      },
    });
  }

  async deleteWhatsappTemplate(organizationId: string, evento: string): Promise<"deleted" | "not_found" | "forbidden" | "unavailable"> {
    return runWithSavepointFallback<"deleted" | "not_found" | "forbidden" | "unavailable">({
      session: this.db,
      savepointName: "sp_citas_wa_templates_delete",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string }>(`delete from core.whatsapp_plantilla where organization_id = $1 and vertical = 'citas' and evento = $2 returning id;`, [organizationId, evento]);
        return rows.length > 0 ? "deleted" : "not_found";
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve("forbidden");
        advertirPlantillasNoDisponibles("deleteWhatsappTemplate", err);
        return Promise.resolve("unavailable");
      },
    });
  }

  async resolveWhatsappTemplate(organizationId: string, evento: string): Promise<PlantillaWhatsappAprobada | null | undefined> {
    return runWithSavepointFallback<PlantillaWhatsappAprobada | null | undefined>({
      session: this.db,
      savepointName: "sp_citas_wa_template_resolve",
      primary: async () => {
        const { rows } = await this.db.query<{ nombre: string; idioma: string; variables: string[] }>(`select nombre, idioma, variables from core.whatsapp_plantilla_resolver($1, $2);`, [organizationId, evento]);
        const row = rows[0];
        return row ? { name: row.nombre, language: row.idioma, variables: row.variables } : null;
      },
      // 42501: una sesion de staff (auth.uid() real) no puede resolver; se actua como "no se puede saber" (comportamiento anterior).
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        advertirPlantillasNoDisponibles("resolveWhatsappTemplate", err);
        return Promise.resolve(undefined);
      },
    });
  }

  async lastInboundWhatsappAt(organizationId: string, phone: string): Promise<string | null | undefined> {
    // El ledger guarda sha256 del telefono tal como llego de Meta y `citas.customers` guarda los ultimos 10 digitos: se prueban las variantes.
    const hashes = variantesTelefonoEntrante(phone).map((v) => actorHash(v));
    return runWithSavepointFallback<string | null | undefined>({
      session: this.db,
      savepointName: "sp_citas_wa_last_inbound",
      primary: async () => {
        const { rows } = await this.db.query<{ ultimo: Date | string | null }>(`select citas.ultimo_mensaje_entrante($1, $2::text[]) as ultimo;`, [organizationId, hashes]);
        const ultimo = rows[0]?.ultimo ?? null;
        return ultimo === null ? null : ultimo instanceof Date ? ultimo.toISOString() : new Date(ultimo).toISOString();
      },
      isRecoverable: (err) => isMigrationPendingError(err) || sqlState(err) === "42501",
      fallback: (err) => {
        advertirPlantillasNoDisponibles("lastInboundWhatsappAt", err);
        return Promise.resolve(undefined);
      },
    });
  }

  async saveWhatsappMessageConfig(organizationId: string, expectedVersion: number, accion: "actualizado" | "restablecido", config: WhatsappMessageConfig): Promise<MensajeConfigGuardado> {
    return runWithSavepointFallback<MensajeConfigGuardado>({
      session: this.db,
      savepointName: "sp_citas_wa_msg_config_save",
      primary: async () => {
        const { rows } = await this.db.query<{ version: number }>(`select citas.save_whatsapp_message_config($1, $2, $3, $4::jsonb) as version;`, [
          organizationId,
          expectedVersion,
          accion,
          JSON.stringify(fotoConfigMensajes(config)),
        ]);
        return { status: "saved", version: Number(rows[0]?.version) };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.save_whatsapp_message_config") || ["AT409", "42501"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        const code = sqlState(err);
        if (code === "AT409") return Promise.resolve({ status: "conflict" });
        if (code === "42501") return Promise.resolve({ status: "forbidden" });
        advertirMensajesNoDisponibles("saveWhatsappMessageConfig", err);
        return Promise.resolve({ status: "unavailable" });
      },
    });
  }

  async listWhatsappMessageConfigHistory(organizationId: string, limit: number): Promise<{ readonly disponible: boolean; readonly items: readonly WhatsappMessageConfigHistoryEntry[] }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly items: readonly WhatsappMessageConfigHistoryEntry[] }>({
      session: this.db,
      savepointName: "sp_citas_wa_msg_config_history",
      primary: async () => {
        const { rows } = await this.db.query<{ version: number; accion: "actualizado" | "restablecido"; anterior: Record<string, unknown> | null; nuevo: Record<string, unknown>; actor_id: string | null; actor_nombre: string | null; created_at: string }>(
          `select version, accion, anterior, nuevo, actor_id, actor_nombre, created_at::text as created_at from citas.whatsapp_message_config_history_list($1, $2);`,
          [organizationId, limit],
        );
        return {
          disponible: true,
          items: rows.map((r) => ({ version: r.version, accion: r.accion, anterior: r.anterior, nuevo: r.nuevo, actorId: r.actor_id, actorNombre: r.actor_nombre, createdAt: r.created_at })),
        };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirMensajesNoDisponibles("listWhatsappMessageConfigHistory", err);
        return Promise.resolve({ disponible: false, items: [] });
      },
    });
  }

  // ---- C-15 -- personalidad del agente y conexion del numero (migracion 028) ----

  async getWhatsappAgentConfig(organizationId: string): Promise<{ readonly disponible: boolean; readonly record: WhatsappAgentConfigRecord | null }> {
    return runWithSavepointFallback<{ readonly disponible: boolean; readonly record: WhatsappAgentConfigRecord | null }>({
      session: this.db,
      savepointName: "sp_citas_wa_agent_config_read",
      primary: async () => {
        const { rows } = await this.db.query<{ agent_name: string | null; tone_style: string | null; greeting_text: string | null; rules_text: string | null; version: number; updated_by: string | null; updated_at: string }>(
          `select agent_name, tone_style, greeting_text, rules_text, version, updated_by, updated_at::text as updated_at
             from citas.whatsapp_agent_config where organization_id = $1;`,
          [organizationId],
        );
        const row = rows[0];
        if (!row) return { disponible: true, record: null };
        return { disponible: true, record: { config: configAgenteDesdeFila(row), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by } };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirAgenteNoDisponible("getWhatsappAgentConfig", err);
        return Promise.resolve({ disponible: false, record: null });
      },
    });
  }

  async getWhatsappAgentConfigForTurn(organizationId: string): Promise<WhatsappAgentConfig | null> {
    return runWithSavepointFallback<WhatsappAgentConfig | null>({
      session: this.db,
      savepointName: "sp_citas_wa_agent_config_turn",
      primary: async () => {
        const { rows } = await this.db.query<{ agent_name: string | null; tone_style: string | null; greeting_text: string | null; rules_text: string | null }>(
          `select agent_name, tone_style, greeting_text, rules_text from citas.whatsapp_agent_config_envio($1);`,
          [organizationId],
        );
        return rows[0] ? configAgenteDesdeFila(rows[0]) : null;
      },
      // 42501: una sesion de staff de OTRA organizacion pidio esta configuracion -- sin acceso se actua como "sin personalidad".
      isRecoverable: (err) => isMigrationPendingError(err, "citas.whatsapp_agent_config_envio") || sqlState(err) === "42501",
      fallback: (err) => {
        advertirAgenteNoDisponible("getWhatsappAgentConfigForTurn", err);
        return Promise.resolve(null);
      },
    });
  }

  async saveWhatsappAgentConfig(organizationId: string, expectedVersion: number, accion: "actualizado" | "restablecido", config: WhatsappAgentConfig): Promise<AgenteConfigGuardado> {
    return runWithSavepointFallback<AgenteConfigGuardado>({
      session: this.db,
      savepointName: "sp_citas_wa_agent_config_save",
      primary: async () => {
        const { rows } = await this.db.query<{ version: number }>(`select citas.save_whatsapp_agent_config($1, $2, $3, $4::jsonb) as version;`, [
          organizationId,
          expectedVersion,
          accion,
          JSON.stringify(fotoConfigAgente(config)),
        ]);
        return { status: "saved", version: Number(rows[0]?.version) };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.save_whatsapp_agent_config") || ["AT409", "42501"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        const code = sqlState(err);
        if (code === "AT409") return Promise.resolve({ status: "conflict" });
        if (code === "42501") return Promise.resolve({ status: "forbidden" });
        advertirAgenteNoDisponible("saveWhatsappAgentConfig", err);
        return Promise.resolve({ status: "unavailable" });
      },
    });
  }

  async getWhatsappConnection(organizationId: string): Promise<WhatsappConnection | null> {
    // La tabla existe desde la migracion 003 y su policy de lectura (miembro de la organizacion) tambien: no necesita SAVEPOINT.
    const { rows } = await this.db.query<{ phone_number_id: string; is_active: boolean }>(`select phone_number_id, is_active from citas.whatsapp_config where organization_id = $1;`, [organizationId]);
    return rows[0] ? { phoneNumberId: rows[0].phone_number_id, isActive: rows[0].is_active } : null;
  }

  async connectWhatsappNumber(organizationId: string, phoneNumberId: string, isActive: boolean): Promise<ConectarNumeroResultado> {
    return runWithSavepointFallback<ConectarNumeroResultado>({
      session: this.db,
      savepointName: "sp_citas_wa_connect_number",
      primary: async () => {
        const { rows } = await this.db.query<{ phone_number_id: string }>(`select citas.connect_whatsapp_number($1, $2, $3) as phone_number_id;`, [organizationId, phoneNumberId, isActive]);
        return { status: "connected", phoneNumberId: String(rows[0]?.phone_number_id) };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.connect_whatsapp_number") || ["AT410", "42501", "22023"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        const code = sqlState(err);
        if (code === "AT410") return Promise.resolve({ status: "in_use" });
        if (code === "42501") return Promise.resolve({ status: "forbidden" });
        if (code === "22023") return Promise.resolve({ status: "invalid" });
        advertirAgenteNoDisponible("connectWhatsappNumber", err);
        return Promise.resolve({ status: "unavailable" });
      },
    });
  }

  async disconnectWhatsappNumber(organizationId: string): Promise<DesconectarNumeroResultado> {
    return runWithSavepointFallback<DesconectarNumeroResultado>({
      session: this.db,
      savepointName: "sp_citas_wa_disconnect_number",
      primary: async () => {
        const { rows } = await this.db.query<{ removed: boolean }>(`select citas.disconnect_whatsapp_number($1) as removed;`, [organizationId]);
        return { status: "disconnected", removed: rows[0]?.removed === true };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.disconnect_whatsapp_number") || sqlState(err) === "42501",
      fallback: (err) => {
        if (sqlState(err) === "42501") return Promise.resolve({ status: "forbidden" });
        advertirAgenteNoDisponible("disconnectWhatsappNumber", err);
        return Promise.resolve({ status: "unavailable" });
      },
    });
  }

  async markReminderSent(appointmentId: string, sentAtIso: string): Promise<void> {
    await this.db.query(`update citas.appointments set reminder_24h_sent_at = $2 where id = $1;`, [appointmentId, sentAtIso]);
  }

  async resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ phone_number_id: string }>(`select phone_number_id from citas.whatsapp_config where organization_id = $1 and is_active = true;`, [organizationId]);
    return rows[0]?.phone_number_id ?? null;
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select citas.enqueue_messaging_outbox($1, $2, $3, $4, $5::jsonb);`, [organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  // ---- Dispatcher real de messaging_outbox (migrations/007) ----

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const { rows } = await this.db.query<{ id: string; attempts: number; payload: unknown; organization_id: string }>(`select id, attempts, payload, organization_id from citas.claim_messaging_outbox_batch($1, $2);`, [limit, leaseSeconds]);
    return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload, organizationId: r.organization_id }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    await this.db.query(`select citas.complete_messaging_outbox_sent($1);`, [id]);
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    await this.db.query(`select citas.complete_messaging_outbox_retry($1, $2, $3, $4);`, [id, attempts, errorClass, nextAttemptAtIso]);
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    await this.db.query(`select citas.complete_messaging_outbox_dead($1, $2, $3);`, [id, attempts, errorClass]);
  }

  async loadLiveWaitlistCandidates(organizationId: string): Promise<readonly WaitlistCandidateRow[]> {
    const { rows } = await this.db.query<{
      id: string;
      customer_phone: string;
      customer_name: string | null;
      notified_count: number;
      provider_id: string | null;
      service_id: string | null;
      preferred_date_from: string | null;
      preferred_date_to: string | null;
      preferred_time_window: "morning" | "afternoon" | "evening" | "any";
      created_at: string;
    }>(
      // f2-citas-lista-de-espera (regla dura #6) — `preferred_date_from`/
      // `preferred_date_to` son columnas `date`; el driver `pg` real las entrega
      // como objeto `Date`, nunca como el `string` que `WaitlistCandidateRow`
      // declara (nunca visible en los tests en memoria, que no pasan por `pg`
      // real) -- `::text` explícito, mismo criterio que
      // `domain-hoteles/src/postgres-repository.ts` (`check_in_date::text`, etc).
      `select id, customer_phone, customer_name, notified_count, provider_id, service_id, preferred_date_from::text, preferred_date_to::text, preferred_time_window, created_at
       from citas.appointment_waitlist
       where organization_id = $1 and status = 'active' and expires_at > now() and notified_count < 3;`,
      [organizationId],
    );
    return rows.map((r) => ({
      id: r.id,
      customerPhone: r.customer_phone,
      customerName: r.customer_name,
      notifiedCount: r.notified_count,
      providerId: r.provider_id,
      serviceId: r.service_id,
      preferredDateFrom: r.preferred_date_from,
      preferredDateTo: r.preferred_date_to,
      preferredTimeWindow: r.preferred_time_window,
      createdAt: r.created_at,
    }));
  }

  /** f2-citas-lista-de-espera, hallazgo (A) — ver el comentario largo de
   * `repository.ts::loadLiveWaitlistCandidatesAsSystem` y de la migración
   * `020_appointment_waitlist_sistema_lectura.sql` para el diseño completo.
   * `citas.system_load_live_waitlist_candidates` es `security definer` de
   * SOLO-SISTEMA (guard `auth.uid() is null`) — bypassa la policy de staff de
   * `citas.appointment_waitlist` (que en sesión de sistema nunca aplica) sin
   * exponer ninguna columna de más. `runWithSavepointFallback` +
   * `isUndefinedFunctionError`: si la migración 020 todavía no está aplicada
   * (SQLSTATE 42883, `undefined_function`), degrada a lista vacía -- el MISMO
   * comportamiento honesto de hoy (0 candidatos vistos, nunca un 500) -- en vez
   * de dejar la sesión de sistema abortada para lo que el caller haga después
   * (ver `tryNotifyWaitlistOfFreedSlot`/el broadcast post-commit, ambos ya
   * envuelven esta llamada en su propio `runWithRowSavepoint`/postCommitTasks,
   * pero el fallback aquí adentro hace que este método sea seguro también para
   * cualquier caller futuro que no sepa de ese detalle). */
  async loadLiveWaitlistCandidatesAsSystem(organizationId: string): Promise<readonly WaitlistCandidateRow[]> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{
          out_id: string;
          out_customer_phone: string;
          out_customer_name: string | null;
          out_notified_count: number;
          out_provider_id: string | null;
          out_service_id: string | null;
          out_preferred_date_from: string | null;
          out_preferred_date_to: string | null;
          out_preferred_time_window: "morning" | "afternoon" | "evening" | "any";
          out_created_at: string;
        }>(`select * from citas.system_load_live_waitlist_candidates($1);`, [organizationId]);
        return rows.map((r) => ({
          id: r.out_id,
          customerPhone: r.out_customer_phone,
          customerName: r.out_customer_name,
          notifiedCount: r.out_notified_count,
          providerId: r.out_provider_id,
          serviceId: r.out_service_id,
          preferredDateFrom: r.out_preferred_date_from,
          preferredDateTo: r.out_preferred_date_to,
          preferredTimeWindow: r.out_preferred_time_window,
          createdAt: r.out_created_at,
        }));
      },
      isRecoverable: isUndefinedFunctionError,
      fallback: (err) => {
        console.warn(
          "loadLiveWaitlistCandidatesAsSystem: citas.system_load_live_waitlist_candidates no existe todavía (SQLSTATE 42883, migración 020 pendiente de aplicar) -- degradando a lista vacía, mismo comportamiento honesto de hoy:",
          err instanceof Error ? err.message : err,
        );
        return Promise.resolve([] as readonly WaitlistCandidateRow[]);
      },
    });
  }

  /** Corrección post-revisión de f2-citas-lista-de-espera — ver el comentario
   * largo de `repository.ts::resolveActiveWhatsAppPhoneNumberIdAsSystem` y de
   * la migración `021_whatsapp_config_sistema_lectura.sql`. Mismo mecanismo
   * SAVEPOINT/SQLSTATE que `loadLiveWaitlistCandidatesAsSystem` (020): si la
   * migración 021 todavía no está aplicada (42883, `undefined_function`),
   * degrada a `null` -- el MISMO comportamiento honesto de hoy
   * (`no_whatsapp_config`/`skippedNoWhatsappConfig:true`, nunca un 500). */
  async resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId: string): Promise<string | null> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ system_resolve_active_whatsapp_phone_number_id: string | null }>(
          `select citas.system_resolve_active_whatsapp_phone_number_id($1) as system_resolve_active_whatsapp_phone_number_id;`,
          [organizationId],
        );
        return rows[0]?.system_resolve_active_whatsapp_phone_number_id ?? null;
      },
      isRecoverable: isUndefinedFunctionError,
      fallback: (err) => {
        console.warn(
          "resolveActiveWhatsAppPhoneNumberIdAsSystem: citas.system_resolve_active_whatsapp_phone_number_id no existe todavía (SQLSTATE 42883, migración 021 pendiente de aplicar) -- degradando a null, mismo comportamiento honesto de hoy:",
          err instanceof Error ? err.message : err,
        );
        return Promise.resolve(null);
      },
    });
  }

  /** Corrección bloqueante de la ronda 2 de revisión del PR #180 — ver el
   * comentario largo de `repository.ts::areSystemWaitlistFunctionsAvailable`.
   * `to_regprocedure` es una consulta de catálogo pura (equivalente a
   * `\df` en `psql`): nunca lanza si la función no existe (a diferencia de
   * `select citas.system_...(...)`, que lanzaría 42883) y no requiere ningún
   * privilegio `EXECUTE` sobre las funciones -- por eso corre segura en la
   * MISMA sesión de staff que ya usa `previewListaEspera`, sin savepoint ni
   * fallback: no hay ningún SQLSTATE que capturar. */
  async areSystemWaitlistFunctionsAvailable(): Promise<boolean> {
    const { rows } = await this.db.query<{ available: boolean }>(
      `select to_regprocedure('citas.system_load_live_waitlist_candidates(uuid)') is not null
          and to_regprocedure('citas.system_resolve_active_whatsapp_phone_number_id(uuid)') is not null as available;`,
    );
    return rows[0]?.available ?? false;
  }

  async claimWaitlistNotificationSlot(waitlistId: string, maxNotifications: number): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string | null }>(`select (citas.claim_waitlist_notification_slot($1, $2)).id as id;`, [waitlistId, maxNotifications]);
    return rows[0]?.id != null;
  }

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ consume_api_rate_limit: boolean }>(`select citas.consume_api_rate_limit($1, $2, $3, $4) as consume_api_rate_limit;`, [scope, actorHash, maxRequests, windowSeconds]);
    return rows[0]?.consume_api_rate_limit === true;
  }

  // ---- Fase 2 §2.6 — plomería de WhatsApp (dedupe + historial). La lease de
  // conversación bespoke NO se porta — ver comentario de migrations/004 y
  // whatsapp/inbound.ts (@atiende/core-conversation::withConversationLock). ----

  async resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ organization_id: string }>(`select organization_id from citas.whatsapp_config where phone_number_id = $1 and is_active = true;`, [phoneNumberId]);
    return rows[0]?.organization_id ?? null;
  }

  /** f2-citas-whatsapp-config-sesion-sistema — ver el comentario largo de
   * `repository.ts::resolveOrganizationByPhoneNumberIdAsSystem` y de la
   * migración `022_whatsapp_config_organizacion_sistema_lectura.sql`. Mismo
   * mecanismo SAVEPOINT/SQLSTATE que `resolveActiveWhatsAppPhoneNumberIdAsSystem`
   * (021): si la migración 022 todavía no está aplicada (42883,
   * `undefined_function`), degrada a `null` -- el MISMO comportamiento
   * honesto de hoy (el webhook trata el mensaje como "número no
   * configurado", nunca un 500). */
  async resolveOrganizationByPhoneNumberIdAsSystem(phoneNumberId: string): Promise<string | null> {
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ system_resolve_organization_by_whatsapp_phone_number_id: string | null }>(
          `select citas.system_resolve_organization_by_whatsapp_phone_number_id($1) as system_resolve_organization_by_whatsapp_phone_number_id;`,
          [phoneNumberId],
        );
        return rows[0]?.system_resolve_organization_by_whatsapp_phone_number_id ?? null;
      },
      isRecoverable: isUndefinedFunctionError,
      fallback: (err) => {
        console.warn(
          "resolveOrganizationByPhoneNumberIdAsSystem: citas.system_resolve_organization_by_whatsapp_phone_number_id no existe todavía (SQLSTATE 42883, migración 022 pendiente de aplicar) -- degradando a null, mismo comportamiento honesto de hoy:",
          err instanceof Error ? err.message : err,
        );
        return Promise.resolve(null);
      },
    });
  }

  async claimWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string): Promise<boolean> {
    const { rows } = await this.db.query<{ claim_whatsapp_message: boolean }>(`select citas.claim_whatsapp_message($1, $2, $3) as claim_whatsapp_message;`, [organizationId, messageId, phoneHash]);
    return rows[0]?.claim_whatsapp_message === true;
  }

  async appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    const { rows } = await this.db.query<{ append_whatsapp_user_message_once: ConversationMessage[] }>(
      `select citas.append_whatsapp_user_message_once($1, $2, $3, $4::jsonb) as append_whatsapp_user_message_once;`,
      [organizationId, `${organizationId}:${phone}:${Date.now()}`, phone, JSON.stringify(message)],
    );
    return rows[0]?.append_whatsapp_user_message_once ?? [message];
  }

  async whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    appointmentId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const { rows } = await this.db.query<{ whatsapp_append_turn: ConversationMessage[] }>(
      `select citas.whatsapp_append_turn($1, $2, $3::jsonb, $4, $5, $6) as whatsapp_append_turn;`,
      [organizationId, phone, JSON.stringify(newMessages), status, appointmentId, propertyId],
    );
    return rows[0]?.whatsapp_append_turn ?? [...newMessages];
  }

  async finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    await this.db.query(`select citas.finish_whatsapp_message($1, $2, $3, $4, $5);`, [organizationId, messageId, phoneHash, status, errorClass]);
  }

  async markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void> {
    await this.db.query(`update citas.whatsapp_inbound_events set status = 'failed', last_error_class = left($3, 120) where message_id = $2 and organization_id = $1;`, [organizationId, messageId, errorClass]);
  }

  // ============================================================================
  // Fase 3 — sincronización con Google Calendar (ver diseño §3/§4/§5, migración
  // 005_google_calendar_sync.sql)
  // ============================================================================

  async findProviderCalendarAccount(providerId: string): Promise<ProviderCalendarAccountRecord | null> {
    const { rows } = await this.db.query<ProviderCalendarAccountRow>(
      `select id, organization_id, provider_id, google_calendar_id, google_watch_channel_id, google_watch_resource_id, google_watch_expires_at, sync_status, sync_error, created_at, updated_at
       from citas.provider_calendar_accounts where provider_id = $1;`,
      [providerId],
    );
    return rows[0] ? mapCalendarAccount(rows[0]) : null;
  }

  async connectProviderCalendarAccount(input: ConnectProviderCalendarAccountInput): Promise<ProviderCalendarAccountRecord> {
    // El refresh token NUNCA toca una columna en claro: se envuelve de inmediato en
    // Supabase Vault vía la RPC `set_provider_calendar_refresh_token` (ver diseño
    // §4 paso 4) — el upsert de abajo solo guarda el `secret_id` que esa RPC
    // devuelve, nunca el token mismo.
    const { rows: existingRows } = await this.db.query<{ google_refresh_token_secret_id: string | null }>(`select google_refresh_token_secret_id from citas.provider_calendar_accounts where provider_id = $1;`, [input.providerId]);
    const existingSecretId = existingRows[0]?.google_refresh_token_secret_id ?? null;

    const { rows: secretRows } = await this.db.query<{ set_provider_calendar_refresh_token: string }>(`select citas.set_provider_calendar_refresh_token($1, $2) as set_provider_calendar_refresh_token;`, [existingSecretId, input.refreshToken]);
    const secretId = secretRows[0]!.set_provider_calendar_refresh_token;

    const { rows } = await this.db.query<ProviderCalendarAccountRow>(
      `insert into citas.provider_calendar_accounts (organization_id, provider_id, google_calendar_id, google_refresh_token_secret_id, sync_status, sync_error)
       values ($1, $2, $3, $4, 'connected', null)
       on conflict (provider_id) do update set
         google_calendar_id = excluded.google_calendar_id,
         google_refresh_token_secret_id = excluded.google_refresh_token_secret_id,
         sync_status = 'connected',
         sync_error = null,
         updated_at = now()
       returning id, organization_id, provider_id, google_calendar_id, google_watch_channel_id, google_watch_resource_id, google_watch_expires_at, sync_status, sync_error, created_at, updated_at;`,
      [input.organizationId, input.providerId, input.googleCalendarId, secretId],
    );
    return mapCalendarAccount(rows[0]!);
  }

  async rotateProviderCalendarRefreshToken(providerId: string, refreshToken: string): Promise<void> {
    const { rows: existingRows } = await this.db.query<{ google_refresh_token_secret_id: string | null }>(`select google_refresh_token_secret_id from citas.provider_calendar_accounts where provider_id = $1;`, [providerId]);
    const secretId = existingRows[0]?.google_refresh_token_secret_id ?? null;
    if (!secretId) return; // sin cuenta conectada -- nada que rotar (no debería pasar en la práctica).
    await this.db.query(`select citas.set_provider_calendar_refresh_token($1, $2);`, [secretId, refreshToken]);
  }

  /**
   * Trata "el RPC de Vault no existe todavía" (Vault/pgsodium no habilitado en este
   * proyecto, ver diseño §4/§9) exactamente igual que "sin proveedor conectado":
   * null, nunca una excepción que tumbe la corrida de reconciliación completa —
   * mismo criterio honesto que `resolveRefreshTokenFromVault` del origen.
   *
   * No-bloqueante de revisión (PR #158, ronda 1) — este `try/catch` atrapaba
   * CUALQUIER error de `citas.get_provider_calendar_refresh_token` SIN `SAVEPOINT`,
   * dentro del `withAppSession` propio del resolver (ver
   * `apps/api/src/production/deps.ts::buildRealGoogleCalendarPortResolver`/
   * `buildRealCalendarSyncPortResolver`, cada invocación abre su PROPIA sesión de
   * una sola consulta). Con la defensa de `managed-postgres-engine.ts` de este PR,
   * un Vault no disponible pasaba de "skip silencioso" a
   * `AbortedTransactionCommitError`: la cita quedaba en `pending` y el cron de
   * reconciliación reportaba error en cada corrida (no se pierden reservas —
   * `tryTriggerCalendarSync`/`syncOneAppointmentRow` ya absorben cualquier error de
   * este resolver — pero sí cambia el comportamiento observable). Mismo patrón
   * `runWithSavepointFallback` que `recordBillingWebhookEvent`
   * (`packages/db/src/postgres-core-repository.ts`): SIEMPRE recuperable, el
   * `fallback` reproduce exactamente el `console.warn` + `null` de antes.
   */
  async resolveProviderCalendarRefreshToken(providerId: string): Promise<string | null> {
    const { rows: accountRows } = await this.db.query<{ google_refresh_token_secret_id: string | null }>(`select google_refresh_token_secret_id from citas.provider_calendar_accounts where provider_id = $1;`, [providerId]);
    const secretId = accountRows[0]?.google_refresh_token_secret_id ?? null;
    if (!secretId) return null;
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ get_provider_calendar_refresh_token: string | null }>(`select citas.get_provider_calendar_refresh_token($1) as get_provider_calendar_refresh_token;`, [secretId]);
        return rows[0]?.get_provider_calendar_refresh_token ?? null;
      },
      isRecoverable: () => true,
      fallback: (err) => {
        console.warn("resolveProviderCalendarRefreshToken: Vault no disponible todavía (Google Calendar real pendiente de infraestructura, ver diseño §4/§9):", err instanceof Error ? err.message : err);
        return Promise.resolve(null);
      },
    });
  }

  async setProviderCalendarAccountSyncError(providerId: string, error: string): Promise<void> {
    await this.db.query(`update citas.provider_calendar_accounts set sync_status = 'error', sync_error = left($2, 500), updated_at = now() where provider_id = $1;`, [providerId, error]);
  }

  private static readonly APPOINTMENT_SYNC_ROW_SELECT = `select
       a.id, a.organization_id, a.provider_id,
       s.name as service_name, c.full_name as customer_name, c.phone as customer_phone, c.email as customer_email,
       a.starts_at, a.ends_at, a.notes,
       coalesce(pc.timezone, tc.default_timezone, 'America/Mexico_City') as time_zone,
       a.google_event_id, a.google_sync_status, a.google_sync_attempts
     from citas.appointments a
     join citas.services s on s.id = a.service_id
     join citas.customers c on c.id = a.customer_id
     left join citas.providers p on p.id = a.provider_id
     left join citas.property_config pc on pc.property_id = p.property_id
     left join citas.tenant_config tc on tc.organization_id = a.organization_id`;

  private mapAppointmentSyncRow(row: {
    id: string;
    organization_id: string;
    provider_id: string;
    service_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    starts_at: string;
    ends_at: string;
    notes: string | null;
    time_zone: string;
    google_event_id: string | null;
    google_sync_status: GoogleSyncStatus;
    google_sync_attempts: number;
  }): AppointmentSyncRow {
    return {
      id: row.id,
      organizationId: row.organization_id,
      providerId: row.provider_id,
      serviceName: row.service_name,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      customerEmail: row.customer_email,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      notes: row.notes,
      timeZone: row.time_zone,
      googleEventId: row.google_event_id,
      googleSyncStatus: row.google_sync_status,
      googleSyncAttempts: row.google_sync_attempts,
    };
  }

  async loadAppointmentSyncRow(appointmentId: string): Promise<AppointmentSyncRow | null> {
    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapAppointmentSyncRow"]>[0]>(`${PostgresCitasRepository.APPOINTMENT_SYNC_ROW_SELECT} where a.id = $1;`, [appointmentId]);
    return rows[0] ? this.mapAppointmentSyncRow(rows[0]) : null;
  }

  async loadPendingGoogleSyncAppointments(limit: number, nowIso: string): Promise<readonly AppointmentSyncRow[]> {
    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapAppointmentSyncRow"]>[0]>(
      `${PostgresCitasRepository.APPOINTMENT_SYNC_ROW_SELECT}
       where a.google_sync_status in ('pending','pending_cancel')
         and a.google_sync_attempts < 5
         and (a.google_sync_next_retry_at is null or a.google_sync_next_retry_at <= $2)
       order by coalesce(a.google_sync_next_retry_at, a.created_at) asc
       limit $1;`,
      [limit, nowIso],
    );
    return rows.map((r) => this.mapAppointmentSyncRow(r));
  }

  async markAppointmentGoogleSynced(appointmentId: string, googleEventId: string, attempts: number): Promise<void> {
    await this.db.query(`update citas.appointments set google_event_id = $2, google_sync_status = 'synced', google_sync_attempts = $3, google_sync_next_retry_at = null, google_sync_error = null where id = $1;`, [appointmentId, googleEventId, attempts]);
  }

  async markAppointmentGoogleSyncDeleted(appointmentId: string, attempts: number): Promise<void> {
    await this.db.query(`update citas.appointments set google_sync_status = 'deleted', google_sync_attempts = $2, google_sync_next_retry_at = null, google_sync_error = null where id = $1;`, [appointmentId, attempts]);
  }

  async markAppointmentGoogleSyncSkipped(appointmentId: string): Promise<void> {
    await this.db.query(`update citas.appointments set google_sync_status = 'skipped', google_sync_next_retry_at = null, google_sync_error = null where id = $1;`, [appointmentId]);
  }

  async markAppointmentGoogleSyncRetry(appointmentId: string, attempts: number, error: string, nextRetryAtIso: string): Promise<void> {
    await this.db.query(`update citas.appointments set google_sync_attempts = $2, google_sync_error = left($3, 500), google_sync_next_retry_at = $4 where id = $1;`, [appointmentId, attempts, error, nextRetryAtIso]);
  }

  // Aislamiento por fila del lote de reconciliación (ver el comentario de cabecera
  // de `runWithRowSavepoint` en `repository.ts` para el diseño completo) —
  // reutiliza el mismo `runWithSavepointFallback`, pero con `isRecoverable` fijo en
  // `true` y un `fallback` que simplemente relanza el mismo error DESPUÉS de que
  // `ROLLBACK TO SAVEPOINT` ya dejó la transacción del lote utilizable para la
  // siguiente fila -- a diferencia de `markAppointmentGoogleSyncInvalid`, aquí no
  // hay una consulta SQL alternativa que correr, solo aislamiento.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw err;
      },
    });
  }

  async markAppointmentGoogleSyncExhausted(appointmentId: string, attempts: number, error: string): Promise<void> {
    await this.db.query(`update citas.appointments set google_sync_status = 'error', google_sync_attempts = $2, google_sync_error = left($3, 500), google_sync_next_retry_at = null where id = $1;`, [appointmentId, attempts, error]);
  }

  // Hallazgo CRÍTICO de auditoría (a1, verificado contra `main` en b4e5a83) — el
  // CHECK vigente en la base real (`migrations/005_google_calendar_sync.sql` ~91-92,
  // `appointments_google_sync_status_check`) NO incluye `'invalid'` — solo lo agrega
  // la migración `019_calendar_sync_error_visibility.sql`, que "mergear a main" NUNCA
  // aplica automáticamente (ver REGLA DURA de docs/DEPLOY.md). Un UPDATE directo con
  // `google_sync_status = 'invalid'` contra la base sin migrar lanza SQLSTATE 23514
  // (`check_violation`) — y esto se dispara con CUALQUIER rechazo 400/404/409/422 del
  // proveedor de calendario (caso normal documentado: reserva Cal.com sin correo del
  // cliente, ver `isPermanentValidationError`/`calendar-sync.ts`).
  //
  // Sin SAVEPOINT, ese 23514 deja ABORTADA la transacción del request (crear/
  // cancelar/reagendar cita, `tryTriggerCalendarSync` corre en la MISMA transacción
  // que la escritura real, ver `appointments.ts`) o del batch del cron
  // (`syncPendingAppointmentsMultiProvider`) — la cita, el correo encolado y el
  // rate-limit del request se revierten en silencio (el `COMMIT` sobre una
  // transacción abortada no lanza error, ver `managed-postgres-engine.ts`), y en el
  // batch, `createEvent` de Google ya corrió (no es idempotente) así que la
  // siguiente corrida duplica el evento en calendarios de tenants sanos. Mismo
  // patrón SAVEPOINT ya usado en `upsertCustomer` de este archivo (~460-491):
  // degrada al UPDATE previo a la migración 019 (`google_sync_status = 'error'`,
  // mismo SQL que `markAppointmentGoogleSyncExhausted`) conservando el motivo
  // legible en `google_sync_error` — la cita queda en un estado FINAL válido en
  // ambas versiones del esquema, nunca se pierde el intento. Cualquier otro código
  // de error se repropaga tal cual (`runWithSavepointFallback` nunca enmascara un
  // fallo real).
  async markAppointmentGoogleSyncInvalid(appointmentId: string, attempts: number, reason: string): Promise<void> {
    await runWithSavepointFallback({
      session: this.db,
      primary: () =>
        this.db.query(
          `update citas.appointments set google_sync_status = 'invalid', google_sync_attempts = $2, google_sync_error = left($3, 500), google_sync_next_retry_at = null where id = $1;`,
          [appointmentId, attempts, reason],
        ),
      isRecoverable: (err) => (err as { code?: string } | null)?.code === "23514",
      fallback: () =>
        this.db.query(
          `update citas.appointments set google_sync_status = 'error', google_sync_attempts = $2, google_sync_error = left($3, 500), google_sync_next_retry_at = null where id = $1;`,
          [appointmentId, attempts, reason],
        ),
    });
  }

  /** Fase 6 §2 (seguimiento) — a diferencia de `runCancelRpc`/confirm/complete/
   * no-show (AT409 se RAISEa y se mapea a `conflict_invalid_status` con un status
   * fijo, ver esos métodos), `retry_appointment_calendar_sync_from_panel`
   * (migrations/019) NUNCA raisea por conflicto de estado -- devuelve
   * `{retried, appointment}` siempre, para que `conflict_invalid_status.status`
   * lleve el `google_sync_status` REAL de la cita en vez de un valor adivinado.
   * AT404/AT403 sí se raisean (cita no encontrada / staff fuera de la sucursal),
   * mismo criterio que el resto del panel. */
  // NOTA (bloqueante r3): mismo argumento -- `runWithRowSavepoint` alrededor del RPC.
  async retryAppointmentCalendarSyncFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<RetryCalendarSyncResult> {
    try {
      const { rows } = await this.runWithRowSavepoint(() =>
        this.db.query<{ result: { retried: boolean; appointment: AppointmentRow } }>(`select citas.retry_appointment_calendar_sync_from_panel($1, $2) as result;`, [organizationId, appointmentId]),
      );
      const result = (rows[0] as unknown as { result: { retried: boolean; appointment: AppointmentRow } }).result;
      const appointment = mapAppointment(result.appointment);
      if (!result.retried) return { outcome: "conflict_invalid_status", status: appointment.googleSyncStatus };
      return { outcome: "retried", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT403") return { outcome: "forbidden_out_of_scope", message: err instanceof Error ? err.message : undefined };
      throw err;
    }
  }

  /** Fase 6 §2 (seguimiento) — ver `CalendarSyncIssuesSummary` (repository.ts) para
   * por qué esto cuenta el subconjunto ACTUAL en `invalid` (nunca un rango de
   * fechas fijo: se autolimpia solo cuando el staff corrige y reintenta). */
  async loadProviderCalendarSyncIssues(providerId: string): Promise<CalendarSyncIssuesSummary> {
    const { rows } = await this.db.query<{ count: string; last_reason: string | null }>(
      `select count(*)::text as count,
              (select google_sync_error from citas.appointments where provider_id = $1 and google_sync_status = 'invalid' order by created_at desc limit 1) as last_reason
         from citas.appointments
        where provider_id = $1 and google_sync_status = 'invalid';`,
      [providerId],
    );
    const row = rows[0];
    return { count: row ? Number(row.count) : 0, lastReason: row?.last_reason ?? null };
  }

  // ============================================================================
  // Fase 6 §1 — guardia de crisis (ver migración 007_crisis_guardrail.sql)
  // ============================================================================

  async findTenantConfig(organizationId: string): Promise<TenantConfigRecord | null> {
    const { rows } = await this.db.query<{ organization_id: string; rubro: string; default_timezone: string; owner_notification_phone: string | null }>(
      `select organization_id, rubro, default_timezone, owner_notification_phone from citas.tenant_config where organization_id = $1;`,
      [organizationId],
    );
    const row = rows[0];
    return row ? { organizationId: row.organization_id, rubro: row.rubro, defaultTimezone: row.default_timezone, ownerNotificationPhone: row.owner_notification_phone } : null;
  }

  /** Fase 8 — upsert real: la fila de `citas.tenant_config` puede no existir
   * todavía (ver comentario de `upsertTenantConfig` en repository.ts) — el
   * `insert ... on conflict do update` con `coalesce(excluded.<col>, tenant_config.<col>)`
   * hace que un patch parcial sobre una fila YA existente respete sus valores
   * actuales para los campos ausentes, y que sobre una fila inexistente use los
   * defaults reales de la columna (los mismos `default` de 001_citas_schema.sql,
   * vía `insert into ... (organization_id, rubro, default_timezone,
   * owner_notification_phone) values ($1, coalesce($2, 'otro'), coalesce($3,
   * 'America/Mexico_City'), $4)`). */
  async upsertTenantConfig(organizationId: string, patch: TenantConfigPatch): Promise<TenantConfigRecord> {
    const { rows } = await this.db.query<{ organization_id: string; rubro: string; default_timezone: string; owner_notification_phone: string | null }>(
      `insert into citas.tenant_config (organization_id, rubro, default_timezone, owner_notification_phone)
       values ($1, coalesce($2, 'otro'), coalesce($3, 'America/Mexico_City'), $4)
       on conflict (organization_id) do update
         set rubro = coalesce($2, citas.tenant_config.rubro),
             default_timezone = coalesce($3, citas.tenant_config.default_timezone),
             owner_notification_phone = case when $5::boolean then $4 else citas.tenant_config.owner_notification_phone end,
             updated_at = now()
       returning organization_id, rubro, default_timezone, owner_notification_phone;`,
      [organizationId, patch.rubro ?? null, patch.defaultTimezone ?? null, patch.ownerNotificationPhone ?? null, patch.ownerNotificationPhone !== undefined],
    );
    const row = rows[0]!;
    return { organizationId: row.organization_id, rubro: row.rubro, defaultTimezone: row.default_timezone, ownerNotificationPhone: row.owner_notification_phone };
  }

  async insertEmergencyEscalation(input: EmergencyEscalationInput): Promise<EmergencyEscalationRecord> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; customer_phone: string; channel: "whatsapp" | "voice"; keyword_matched: string; message_excerpt: string; created_at: string }>(
      `insert into citas.emergency_escalations (organization_id, customer_phone, channel, keyword_matched, message_excerpt)
       values ($1, $2, $3, $4, $5)
       returning id, organization_id, customer_phone, channel, keyword_matched, message_excerpt, created_at;`,
      [input.organizationId, input.customerPhone, input.channel, input.keywordMatched, input.messageExcerpt],
    );
    const row = rows[0]!;
    // Notificacion in-app (productor compartido, `citas.escalacion.crisis`): una escalacion de crisis es lo mas urgente que puede pasar en
    // el canal. Una por escalacion (clave = id), a owner/admin, sin PII (texto fijo del catalogo: ni telefono ni mensaje del cliente).
    // El SAVEPOINT de emitirNotificacion hace que, contra la base sin migrar (0039), la transaccion del webhook no quede abortada.
    await emitirNotificacion(this.db, { evento: "citas.escalacion.crisis", organizationId: row.organization_id, clave: row.id, entidadTipo: "emergency_escalation", entidadId: row.id });
    return { id: row.id, organizationId: row.organization_id, customerPhone: row.customer_phone, channel: row.channel, keywordMatched: row.keyword_matched, messageExcerpt: row.message_excerpt, createdAt: row.created_at };
  }

  // ---- C-16 -- centro de avisos (migracion 029). Todo con SAVEPOINT: la base sin migrar responde "no disponible", nunca aborta la transaccion. ----
  async listEscalaciones(organizationId: string, limit: number): Promise<EscalacionesPage> {
    const tope = Math.min(200, Math.max(1, Math.trunc(limit)));
    type FilaEsc = { id: string; channel: "whatsapp" | "voice"; keyword_matched: string; customer_phone: string; created_at: string; follow_up_status?: EscalacionSeguimientoEstado; follow_up_at?: string | null; follow_up_note?: string | null };
    const mapear = (r: FilaEsc, conSeguimiento: boolean): EscalacionVista => ({
      id: r.id,
      channel: r.channel,
      keywordMatched: r.keyword_matched,
      customerPhone: r.customer_phone,
      createdAt: r.created_at,
      seguimiento: conSeguimiento ? (r.follow_up_status ?? "pending") : null,
      seguimientoAt: conSeguimiento ? (r.follow_up_at ?? null) : null,
      seguimientoNota: conSeguimiento ? (r.follow_up_note ?? null) : null,
    });
    return runWithSavepointFallback<EscalacionesPage>({
      session: this.db,
      savepointName: "sp_citas_escalaciones_list",
      primary: async () => {
        const { rows } = await this.db.query<FilaEsc>(
          `select id, channel, keyword_matched, customer_phone, created_at::text as created_at, follow_up_status, follow_up_at::text as follow_up_at, follow_up_note
             from citas.emergency_escalations where organization_id = $1
            order by case follow_up_status when 'pending' then 0 when 'in_progress' then 1 else 2 end, created_at desc, id desc limit $2;`,
          [organizationId, tope],
        );
        return { disponible: true, seguimientoDisponible: true, items: rows.map((r) => mapear(r, true)) };
      },
      isRecoverable: isMigrationPendingError,
      // Sin las columnas de seguimiento (42703): la lista sigue saliendo, sin estado. Segundo SAVEPOINT por si la tabla tampoco existe.
      fallback: () =>
        runWithSavepointFallback<EscalacionesPage>({
          session: this.db,
          savepointName: "sp_citas_escalaciones_list_base",
          primary: async () => {
            const { rows } = await this.db.query<FilaEsc>(
              `select id, channel, keyword_matched, customer_phone, created_at::text as created_at
                 from citas.emergency_escalations where organization_id = $1 order by created_at desc, id desc limit $2;`,
              [organizationId, tope],
            );
            return { disponible: true, seguimientoDisponible: false, items: rows.map((r) => mapear(r, false)) };
          },
          isRecoverable: isMigrationPendingError,
          fallback: () => Promise.resolve({ disponible: false, seguimientoDisponible: false, items: [] }),
        }),
    });
  }

  async setEscalacionSeguimiento(organizationId: string, escalationId: string, estado: EscalacionSeguimientoDestino, nota: string | null): Promise<SetEscalacionSeguimientoResult> {
    return runWithSavepointFallback<SetEscalacionSeguimientoResult>({
      session: this.db,
      savepointName: "sp_citas_escalacion_seguimiento",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_status: EscalacionSeguimientoEstado; out_at: string }>(
          `select out_id, out_status, out_at::text as out_at from citas.set_escalation_follow_up($1, $2, $3, $4);`,
          [organizationId, escalationId, estado, nota],
        );
        const row = rows[0];
        if (!row) return { outcome: "not_found" };
        return { outcome: "updated", id: row.out_id, estado: row.out_status, en: row.out_at };
      },
      // La base sin migrar Y los errores de negocio de la propia funcion (P0002 no existe, 22023 estado, 42501 sin rol) se resuelven DENTRO del SAVEPOINT.
      isRecoverable: (err) => isMigrationPendingError(err, "citas.set_escalation_follow_up") || ["P0002", "22023", "42501"].includes(sqlState(err) ?? ""),
      fallback: (err) => {
        switch (sqlState(err)) {
          case "P0002":
            return Promise.resolve({ outcome: "not_found" });
          case "22023":
            return Promise.resolve({ outcome: "invalid_input" });
          case "42501":
            return Promise.resolve({ outcome: "forbidden" });
          default:
            return Promise.resolve({ outcome: "unavailable" });
        }
      },
    });
  }

  async systemAvisosResumen(organizationId: string): Promise<AvisosResumenSistema | null> {
    return runWithSavepointFallback<AvisosResumenSistema | null>({
      session: this.db,
      savepointName: "sp_citas_avisos_resumen",
      primary: async () => {
        const { rows } = await this.db.query<{ por_confirmar: string; recordatorios_agotados: string; ultimo_agotado_epoch: string | null; escalaciones_sin_seguimiento: string }>(
          `select por_confirmar::text, recordatorios_agotados::text, ultimo_agotado_epoch::text, escalaciones_sin_seguimiento::text from citas.system_avisos_resumen($1);`,
          [organizationId],
        );
        const r = rows[0];
        if (!r) return null;
        return {
          porConfirmar: Number(r.por_confirmar),
          recordatoriosAgotados: Number(r.recordatorios_agotados),
          ultimoAgotadoEpoch: r.ultimo_agotado_epoch === null ? null : Number(r.ultimo_agotado_epoch),
          escalacionesSinSeguimiento: Number(r.escalaciones_sin_seguimiento),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.system_avisos_resumen"),
      fallback: () => Promise.resolve(null),
    });
  }

  async recordatoriosPorEstado(organizationId: string, fromIso: string, toIso: string): Promise<readonly RecordatorioEntregaFila[] | null> {
    return runWithSavepointFallback<readonly RecordatorioEntregaFila[] | null>({
      session: this.db,
      savepointName: "sp_citas_recordatorios_por_estado",
      primary: async () => {
        const { rows } = await this.db.query<{ channel: string; status: string; total: string }>(
          `select channel, status, total::text from citas.data_chat_reminder_delivery($1::uuid, null::uuid[], $2::timestamptz, $3::timestamptz);`,
          [organizationId, fromIso, toIso],
        );
        return rows.map((r) => ({ channel: r.channel, status: r.status, total: Number(r.total) }));
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.data_chat_reminder_delivery"),
      fallback: () => Promise.resolve(null),
    });
  }

  async findOrganizationById(organizationId: string): Promise<{ readonly id: string; readonly name: string } | null> {
    const { rows } = await this.db.query<{ id: string; name: string }>(`select id, name from core.organization where id = $1;`, [organizationId]);
    const row = rows[0];
    return row ? { id: row.id, name: row.name } : null;
  }

  // ============================================================================
  // Fase 6 §2 — Cal.com/CalDAV por proveedor (ver migración
  // 008_calendar_provider_accounts.sql) — reutiliza las mismas funciones de Vault
  // genéricas de Fase 3 (citas.set_provider_calendar_refresh_token/
  // citas.get_provider_calendar_refresh_token), ver comentario de esa migración.
  // ============================================================================

  private mapCalComAccount(row: { id: string; organization_id: string; provider_id: string; calcom_event_type_id: string; calcom_base_url: string | null; sync_status: CalendarProviderSyncStatus; sync_error: string | null; created_at: string; updated_at: string }): ProviderCalComAccountRecord {
    return { id: row.id, organizationId: row.organization_id, providerId: row.provider_id, calcomEventTypeId: row.calcom_event_type_id, baseUrl: row.calcom_base_url, syncStatus: row.sync_status, syncError: row.sync_error, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async findProviderCalComAccount(providerId: string): Promise<ProviderCalComAccountRecord | null> {
    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapCalComAccount"]>[0]>(
      `select id, organization_id, provider_id, calcom_event_type_id, calcom_base_url, sync_status, sync_error, created_at, updated_at from citas.provider_calcom_accounts where provider_id = $1;`,
      [providerId],
    );
    return rows[0] ? this.mapCalComAccount(rows[0]) : null;
  }

  async connectProviderCalComAccount(input: ConnectProviderCalComAccountInput): Promise<ProviderCalComAccountRecord> {
    const { rows: existingRows } = await this.db.query<{ calcom_api_key_secret_id: string | null }>(`select calcom_api_key_secret_id from citas.provider_calcom_accounts where provider_id = $1;`, [input.providerId]);
    const existingSecretId = existingRows[0]?.calcom_api_key_secret_id ?? null;
    const { rows: secretRows } = await this.db.query<{ set_provider_calendar_refresh_token: string }>(`select citas.set_provider_calendar_refresh_token($1, $2) as set_provider_calendar_refresh_token;`, [existingSecretId, input.apiKey]);
    const secretId = secretRows[0]!.set_provider_calendar_refresh_token;

    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapCalComAccount"]>[0]>(
      `insert into citas.provider_calcom_accounts (organization_id, provider_id, calcom_event_type_id, calcom_base_url, calcom_api_key_secret_id, sync_status, sync_error)
       values ($1, $2, $3, $4, $5, 'connected', null)
       on conflict (provider_id) do update set
         calcom_event_type_id = excluded.calcom_event_type_id,
         calcom_base_url = excluded.calcom_base_url,
         calcom_api_key_secret_id = excluded.calcom_api_key_secret_id,
         sync_status = 'connected',
         sync_error = null,
         updated_at = now()
       returning id, organization_id, provider_id, calcom_event_type_id, calcom_base_url, sync_status, sync_error, created_at, updated_at;`,
      [input.organizationId, input.providerId, input.calcomEventTypeId, input.baseUrl ?? null, secretId],
    );
    return this.mapCalComAccount(rows[0]!);
  }

  async disconnectProviderCalComAccount(providerId: string): Promise<void> {
    await this.db.query(`update citas.provider_calcom_accounts set sync_status = 'disconnected', sync_error = null, updated_at = now() where provider_id = $1;`, [providerId]);
  }

  /** No-bloqueante de re-revisión (PR #158, r3) — sitio hermano IDÉNTICO de
   * `resolveProviderCalendarRefreshToken` (ver su comentario de cabecera para el
   * diseño completo): este `try/catch` atrapaba CUALQUIER error de
   * `citas.get_provider_calendar_refresh_token` SIN `SAVEPOINT`, dentro de la MISMA
   * sesión que `createCalendarSyncPortResolver` reutiliza para 3-6 consultas
   * (Google, Cal.com, CalDAV — ver `calendar-sync-resolver-factory.ts`). Sin
   * SAVEPOINT, un Vault no disponible aquí dejaba la sesión abortada para la
   * SIGUIENTE cuenta que ese mismo resolver intente resolver en la misma corrida
   * (ej. si Cal.com falla, la búsqueda de CalDAV que sigue daría 25P02 en vez de
   * intentar su propio camino). */
  async resolveProviderCalComApiKey(providerId: string): Promise<string | null> {
    const { rows: accountRows } = await this.db.query<{ calcom_api_key_secret_id: string | null }>(`select calcom_api_key_secret_id from citas.provider_calcom_accounts where provider_id = $1;`, [providerId]);
    const secretId = accountRows[0]?.calcom_api_key_secret_id ?? null;
    if (!secretId) return null;
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ get_provider_calendar_refresh_token: string | null }>(`select citas.get_provider_calendar_refresh_token($1) as get_provider_calendar_refresh_token;`, [secretId]);
        return rows[0]?.get_provider_calendar_refresh_token ?? null;
      },
      isRecoverable: () => true,
      fallback: (err) => {
        console.warn("resolveProviderCalComApiKey: Vault no disponible todavía:", err instanceof Error ? err.message : err);
        return Promise.resolve(null);
      },
    });
  }

  async setProviderCalComAccountSyncError(providerId: string, error: string): Promise<void> {
    await this.db.query(`update citas.provider_calcom_accounts set sync_status = 'error', sync_error = left($2, 500), updated_at = now() where provider_id = $1;`, [providerId, error]);
  }

  async markProviderCalComAccountSyncOk(providerId: string): Promise<void> {
    await this.db.query(`update citas.provider_calcom_accounts set sync_status = 'connected', sync_error = null, updated_at = now() where provider_id = $1 and sync_status <> 'disconnected';`, [providerId]);
  }

  private mapCalDavAccount(row: { id: string; organization_id: string; provider_id: string; caldav_calendar_collection_url: string; caldav_username: string; sync_status: CalendarProviderSyncStatus; sync_error: string | null; created_at: string; updated_at: string }): ProviderCalDavAccountRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      providerId: row.provider_id,
      calendarCollectionUrl: row.caldav_calendar_collection_url,
      username: row.caldav_username,
      syncStatus: row.sync_status,
      syncError: row.sync_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findProviderCalDavAccount(providerId: string): Promise<ProviderCalDavAccountRecord | null> {
    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapCalDavAccount"]>[0]>(
      `select id, organization_id, provider_id, caldav_calendar_collection_url, caldav_username, sync_status, sync_error, created_at, updated_at from citas.provider_caldav_accounts where provider_id = $1;`,
      [providerId],
    );
    return rows[0] ? this.mapCalDavAccount(rows[0]) : null;
  }

  async connectProviderCalDavAccount(input: ConnectProviderCalDavAccountInput): Promise<ProviderCalDavAccountRecord> {
    const { rows: existingRows } = await this.db.query<{ caldav_password_secret_id: string | null }>(`select caldav_password_secret_id from citas.provider_caldav_accounts where provider_id = $1;`, [input.providerId]);
    const existingSecretId = existingRows[0]?.caldav_password_secret_id ?? null;
    const { rows: secretRows } = await this.db.query<{ set_provider_calendar_refresh_token: string }>(`select citas.set_provider_calendar_refresh_token($1, $2) as set_provider_calendar_refresh_token;`, [existingSecretId, input.password]);
    const secretId = secretRows[0]!.set_provider_calendar_refresh_token;

    const { rows } = await this.db.query<Parameters<PostgresCitasRepository["mapCalDavAccount"]>[0]>(
      `insert into citas.provider_caldav_accounts (organization_id, provider_id, caldav_calendar_collection_url, caldav_username, caldav_password_secret_id, sync_status, sync_error)
       values ($1, $2, $3, $4, $5, 'connected', null)
       on conflict (provider_id) do update set
         caldav_calendar_collection_url = excluded.caldav_calendar_collection_url,
         caldav_username = excluded.caldav_username,
         caldav_password_secret_id = excluded.caldav_password_secret_id,
         sync_status = 'connected',
         sync_error = null,
         updated_at = now()
       returning id, organization_id, provider_id, caldav_calendar_collection_url, caldav_username, sync_status, sync_error, created_at, updated_at;`,
      [input.organizationId, input.providerId, input.calendarCollectionUrl, input.username, secretId],
    );
    return this.mapCalDavAccount(rows[0]!);
  }

  async disconnectProviderCalDavAccount(providerId: string): Promise<void> {
    await this.db.query(`update citas.provider_caldav_accounts set sync_status = 'disconnected', sync_error = null, updated_at = now() where provider_id = $1;`, [providerId]);
  }

  /** No-bloqueante de re-revisión (PR #158, r3) — mismo sitio hermano que
   * `resolveProviderCalComApiKey` de arriba (ver su comentario para el diseño
   * completo): idéntico riesgo de dejar la sesión compartida de
   * `createCalendarSyncPortResolver` abortada para la siguiente cuenta de la misma
   * corrida si Vault falla aquí sin SAVEPOINT. */
  async resolveProviderCalDavPassword(providerId: string): Promise<string | null> {
    const { rows: accountRows } = await this.db.query<{ caldav_password_secret_id: string | null }>(`select caldav_password_secret_id from citas.provider_caldav_accounts where provider_id = $1;`, [providerId]);
    const secretId = accountRows[0]?.caldav_password_secret_id ?? null;
    if (!secretId) return null;
    return runWithSavepointFallback({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ get_provider_calendar_refresh_token: string | null }>(`select citas.get_provider_calendar_refresh_token($1) as get_provider_calendar_refresh_token;`, [secretId]);
        return rows[0]?.get_provider_calendar_refresh_token ?? null;
      },
      isRecoverable: () => true,
      fallback: (err) => {
        console.warn("resolveProviderCalDavPassword: Vault no disponible todavía:", err instanceof Error ? err.message : err);
        return Promise.resolve(null);
      },
    });
  }

  async setProviderCalDavAccountSyncError(providerId: string, error: string): Promise<void> {
    await this.db.query(`update citas.provider_caldav_accounts set sync_status = 'error', sync_error = left($2, 500), updated_at = now() where provider_id = $1;`, [providerId, error]);
  }

  async markProviderCalDavAccountSyncOk(providerId: string): Promise<void> {
    await this.db.query(`update citas.provider_caldav_accounts set sync_status = 'connected', sync_error = null, updated_at = now() where provider_id = $1 and sync_status <> 'disconnected';`, [providerId]);
  }

  // ============================================================================
  // Fase 6 §3 — dispatcher de correo (ver migración 009_email_outbox_dispatch.sql)
  // ============================================================================

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(`select id, organization_id, attempts, payload from citas.claim_email_outbox_batch($1);`, [limit]);
    return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select citas.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // ============================================================================
  // FASE 3 (producto) -- bitácora de auditoría del staff, ver
  // migrations/023_citas_audit_log.sql. Mismo patrón EXACTO que
  // `PostgresRestaurantesRepository.registrarAuditoria`/`.listAuditoria`, reescrito
  // sobre el helper compartido `runWithSavepointFallback` (@atiende/db) que este
  // archivo ya usa para el resto de sus SAVEPOINT (ver `runWithRowSavepoint`/
  // `markAppointmentGoogleSyncInvalid` arriba) en vez del SAVEPOINT/ROLLBACK TO
  // SAVEPOINT/RELEASE a mano que domain-restaurantes escribió antes de que ese
  // helper existiera.
  // ============================================================================

  /**
   * Nunca lanza -- best-effort real (regla dura de esta fase, ver AGENTS.md): un
   * error real de Postgres dentro de esta transacción compartida (misma
   * `dbSession`/`withAppSession` del request de staff) deja la transacción
   * "abortada" si no se recupera con un SAVEPOINT -- la SIGUIENTE consulta
   * (incluido el `commit` final del request) fallaría con 25P02, revirtiendo la
   * acción de negocio que ya había corrido con éxito antes de llamar aquí. La
   * capa exterior try/catch cubre además cualquier error NO cubierto por
   * `isMigrationPendingError` (ej. un bug real de tipos) -- la regla dura no
   * distingue "por qué" falló la bitácora, solo que nunca puede tumbar ni
   * revertir la acción de negocio ya hecha.
   */
  async registrarAuditoria(input: RegistrarCitasAuditoriaInput): Promise<void> {
    try {
      await runWithSavepointFallback({
        session: this.db,
        savepointName: CITAS_AUDIT_LOG_WRITE_SAVEPOINT,
        primary: async () => {
          await this.db.query(`select citas.record_audit_log($1, $2, $3, $4, $5, $6, $7);`, [
            input.organizationId,
            input.action,
            input.entityType,
            input.entityId,
            input.campo ?? null,
            input.antes ?? null,
            input.despues ?? null,
          ]);
        },
        isRecoverable: (err) => isMigrationPendingError(err, "citas.record_audit_log"),
        fallback: (err) => {
          advertirCitasAuditLogEscrituraNoDisponible(err);
          return Promise.resolve();
        },
      });
    } catch (err) {
      console.error("PostgresCitasRepository.registrarAuditoria: fallo inesperado al escribir en citas.audit_log (la acción de negocio ya se completó y NO se revierte).", err);
    }
  }

  async listAuditoria(organizationId: string, filtro: CitasAuditLogFiltro, paginacion: CitasAuditLogPaginacion): Promise<CitasAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    const params: unknown[] = [organizationId];
    const condiciones = ["organization_id = $1"];
    if (filtro.entityType) {
      params.push(filtro.entityType);
      condiciones.push(`entity_type = $${params.length}`);
    }
    // Mismo criterio EXACTO que `PostgresRestaurantesRepository.listAuditoria`:
    // ancla `desde`/`hasta` a America/Mexico_City con offset fijo `-06:00`
    // (México no tiene horario de verano nacional desde 2022) -- comparar
    // contra `created_at >= $n::date` usaría la zona horaria de la SESIÓN de
    // Postgres (UTC), y una acción de las 18:00 a las 23:59 hora de México
    // caería en el día SIGUIENTE del filtro.
    if (filtro.desde) {
      params.push(`${filtro.desde}T00:00:00-06:00`);
      condiciones.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filtro.hasta) {
      // Extremo inclusivo -- `hasta` es una fecha (sin hora), así que compara
      // contra el INICIO del día siguiente en vez de `<=`.
      params.push(`${filtro.hasta}T00:00:00-06:00`);
      condiciones.push(`created_at < ($${params.length}::timestamptz + interval '1 day')`);
    }
    const where = condiciones.join(" and ");

    return runWithSavepointFallback<CitasAuditLogPagina>({
      session: this.db,
      savepointName: CITAS_AUDIT_LOG_READ_SAVEPOINT,
      primary: async () => {
        const totalResult = await this.db.query<{ total: string }>(`select count(*)::text as total from citas.audit_log where ${where};`, params);
        const total = Number(totalResult.rows[0]?.total ?? 0);

        const limitOffsetParams = [...params, limit, offset];
        // Orden TOTAL desde el día uno (`seq` ya existe en migrations/023, ver
        // su comentario de cabecera) -- nunca hace falta un fallback anidado
        // por "seq no existe todavía" (a diferencia de rentas).
        const { rows } = await this.db.query<CitasAuditLogRowSql>(
          `select id, actor_user_id, action, entity_type, entity_id, campo, antes, despues, created_at::text as created_at
           from citas.audit_log where ${where} order by created_at desc, seq desc limit $${limitOffsetParams.length - 1} offset $${limitOffsetParams.length};`,
          limitOffsetParams,
        );

        const items = rows.map(mapCitasAuditLogRow);
        return { disponible: true, items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirCitasAuditLogLecturaNoDisponible(err);
        return Promise.resolve({ disponible: false, items: [], total: 0, nextOffset: null });
      },
    });
  }

  // ---- C-02 -- solicitudes de derechos ARCO ----

  async registerDataRightsRequestAsSystem(input: { readonly organizationId: string; readonly customerPhone: string; readonly rightType: DataRightType; readonly detail: string | null }): Promise<RegisterDataRightsOutcome> {
    return runWithSavepointFallback<RegisterDataRightsOutcome>({
      session: this.db,
      savepointName: "sp_citas_data_rights_register",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_status: DataRightStatus; out_already_open: boolean; out_response_due_at: string | null }>(
          `select out_id, out_status, out_already_open, out_response_due_at::text as out_response_due_at from citas.system_register_data_rights_request($1, $2, $3, 'whatsapp', $4);`,
          [input.organizationId, input.customerPhone, input.rightType, input.detail],
        );
        const row = rows[0];
        if (!row) return { available: false };
        return { available: true, id: row.out_id, status: row.out_status, alreadyOpen: row.out_already_open, responseDueAt: row.out_response_due_at };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.system_register_data_rights_request"),
      fallback: (err) => {
        advertirDataRightsNoDisponible("registerDataRightsRequestAsSystem", err);
        return Promise.resolve({ available: false });
      },
    });
  }

  async resolveDataRightsConfirmationAsSystem(organizationId: string, customerPhone: string, confirm: boolean): Promise<ConfirmDataRightsOutcome> {
    return runWithSavepointFallback<ConfirmDataRightsOutcome>({
      session: this.db,
      savepointName: "sp_citas_data_rights_confirm",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_right_type: DataRightType; out_status: DataRightStatus; out_response_due_at: string | null; out_execution_due_at: string | null }>(
          `select out_id, out_right_type, out_status, out_response_due_at::text as out_response_due_at, out_execution_due_at::text as out_execution_due_at from citas.system_resolve_data_rights_confirmation($1, $2, $3);`,
          [organizationId, customerPhone, confirm],
        );
        const row = rows[0];
        if (!row) return { available: true, found: false };
        return { available: true, found: true, id: row.out_id, rightType: row.out_right_type, status: row.out_status, responseDueAt: row.out_response_due_at, executionDueAt: row.out_execution_due_at };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "citas.system_resolve_data_rights_confirmation"),
      fallback: (err) => {
        advertirDataRightsNoDisponible("resolveDataRightsConfirmationAsSystem", err);
        return Promise.resolve({ available: false });
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
      savepointName: "sp_citas_data_rights_list",
      primary: async () => {
        const totalResult = await this.db.query<{ total: string }>(`select count(*)::text as total from citas.data_rights_requests where ${where};`, params);
        const total = Number(totalResult.rows[0]?.total ?? 0);
        const pageParams = [...params, limit, offset];
        const { rows } = await this.db.query<DataRightsRequestRowSql>(
          `select id, customer_phone, right_type, channel, status, detail, requested_at::text as requested_at, confirmed_at::text as confirmed_at,
                  response_due_at::text as response_due_at, execution_due_at::text as execution_due_at, resolved_at::text as resolved_at,
                  resolution_note, handled_by, updated_at::text as updated_at
             from citas.data_rights_requests where ${where} order by created_at desc, seq desc limit $${pageParams.length - 1} offset $${pageParams.length};`,
          pageParams,
        );
        const items = rows.map(mapDataRightsRequestRow);
        return { disponible: true, items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
      },
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirDataRightsNoDisponible("listDataRightsRequests", err);
        return Promise.resolve({ disponible: false, items: [], total: 0, nextOffset: null });
      },
    });
  }

  async listDataRightsEvents(organizationId: string, requestId: string): Promise<readonly DataRightsEventRow[] | null> {
    return runWithSavepointFallback<readonly DataRightsEventRow[] | null>({
      session: this.db,
      savepointName: "sp_citas_data_rights_events",
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
             from citas.data_rights_events where organization_id = $1 and request_id = $2 order by created_at asc, seq asc;`,
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
        advertirDataRightsNoDisponible("listDataRightsEvents", err);
        return Promise.resolve(null);
      },
    });
  }

  async updateDataRightsRequestStatus(organizationId: string, requestId: string, status: DataRightStaffTargetStatus, note: string | null): Promise<UpdateDataRightsStatusResult> {
    return runWithSavepointFallback<UpdateDataRightsStatusResult>({
      session: this.db,
      savepointName: "sp_citas_data_rights_update",
      primary: async () => {
        const { rows } = await this.db.query<{ out_id: string; out_status: DataRightStatus }>(
          `select out_id, out_status from citas.update_data_rights_request_status($1, $2, $3, $4);`,
          [organizationId, requestId, status, note],
        );
        const row = rows[0];
        if (!row) return { outcome: "not_found" };
        return { outcome: "updated", id: row.out_id, status: row.out_status };
      },
      // La base sin migrar (42883/42P01/42703) Y los errores de negocio de la propia
      // función SQL (P0002 no existe, 55000 transición inválida, 22023 parámetro,
      // 42501 sin rol) son recuperables: todos se resuelven DENTRO del SAVEPOINT.
      isRecoverable: (err) => isMigrationPendingError(err, "citas.update_data_rights_request_status") || ["P0002", "55000", "22023", "42501"].includes(sqlState(err) ?? ""),
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
            advertirDataRightsNoDisponible("updateDataRightsRequestStatus", err);
            return Promise.resolve({ outcome: "unavailable" });
        }
      },
    });
  }
}
