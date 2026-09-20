// InMemoryCitasRepository — implementación real (no un mock) de `CitasRepository`,
// con las mismas restricciones de integridad e idempotencia que las migraciones SQL
// de migrations/001-003 (EXCLUDE anti-traslape por provider+rango, UNIQUE de
// idempotency_key, pg_advisory_xact_lock vía serialización por clave). Sirve como
// fixture de seed para tests determinísticos y como fallback dev/CI sin Postgres
// real — mismo rol que InMemoryRestaurantesRepository/InMemoryHotelesRepository.
import { randomUUID } from "node:crypto";
import { MAX_SYNC_ATTEMPTS } from "./calendar-sync.ts";
import type {
  AppointmentActorChannel,
  AppointmentRecord,
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
  CalendarProviderSyncStatus,
  CalendarSyncIssuesSummary,
  CancelResult,
  CitasRepository,
  CompleteResult,
  ConfirmResult,
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
  MessagingOutboxRow,
  NewAppointmentFromPanelInput,
  NewAppointmentInput,
  NoShowResult,
  ProviderCalComAccountRecord,
  ProviderCalDavAccountRecord,
  ReassignResult,
  RescheduleResult,
  ReminderCandidateRow,
  RetryCalendarSyncResult,
  TenantConfigPatch,
  TenantConfigRecord,
  WaitlistCandidateRow,
} from "./repository.ts";

// FASE 3 (producto) -- mismos límites que el CHECK de `citas.audit_log` (ver
// migrations/023_citas_audit_log.sql) -- mismo criterio EXACTO que
// `InMemoryRestaurantesRepository`/`InMemoryRentasRepository` (ver el comentario
// dentro de `registrarAuditoria` de abajo).
const AUDIT_LOG_CAMPO_MAX = 200;
const AUDIT_LOG_TEXTO_MAX = 500;

function truncarCampoAuditoriaCitas(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Serializa operaciones por clave — equivalente en memoria de
 * `pg_advisory_xact_lock`/row lock de Postgres: dos llamadas concurrentes con la
 * MISMA clave se ejecutan una tras otra, nunca entrelazadas. */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.chains.set(key, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface StoredOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly defaultTimezone: string;
}

/** Fase 5 §1 — equivalente en memoria de una fila de `core.property` (ver
 * `listPropertiesForOrganization`). No hay tabla `citas.branch_detail` que unir
 * (citas no tiene concepto propio de sucursal, ver diseño Fase 1 §2) — solo
 * id+nombre. */
interface StoredCitasProperty {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly name: string;
}

interface StoredWaitlistRow {
  id: string;
  organizationId: string;
  customerPhone: string;
  customerName: string | null;
  providerId: string | null;
  serviceId: string | null;
  preferredDateFrom: string | null;
  preferredDateTo: string | null;
  preferredTimeWindow: "morning" | "afternoon" | "evening" | "any";
  status: "active" | "notified" | "fulfilled" | "cancelled" | "expired";
  notifiedCount: number;
  expiresAt: string;
  createdAt: string;
}

function overlapsRange(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

interface StoredWhatsAppEvent {
  status: "processing" | "processed" | "failed";
  attempts: number;
  claimedAt: number;
}

interface StoredConversation {
  messages: ConversationMessage[];
  status: "active" | "completed" | "abandoned";
  appointmentId: string | null;
  propertyId: string | null;
}

/** Espejo en memoria de `citas.messaging_outbox` (migrations/003+007) — mismo
 * idioma de claim-con-lease-reclamable que `StoredWhatsAppEvent`. */
interface InMemoryOutboxRow {
  id: string;
  organizationId: string;
  channel: "whatsapp" | "email";
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  claimedAt: number | null;
  nextAttemptAt: number;
  lastErrorClass: string | null;
  /** Fase 6 §3 — dispatcher de email (migrations/009): columna separada de
   *  `lastErrorClass` (WhatsApp), mismo criterio que el SQL real. */
  lastError: string | null;
}

export class InMemoryCitasRepository implements CitasRepository {
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly organizationIdBySlug = new Map<string, string>();
  private readonly propertyTimezones = new Map<string, string>();
  private readonly citasProperties = new Map<string, StoredCitasProperty>(); // por propertyId
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly providerServices = new Set<string>(); // `${providerId}:${serviceId}`
  private readonly availabilityRules = new Map<string, AvailabilityRule[]>(); // por providerId
  private readonly availabilityOverrides = new Map<string, AvailabilityOverride>(); // `${providerId}:${date}`
  private readonly customers = new Map<string, CustomerRecord>();
  private readonly customerIdByOrgPhone = new Map<string, string>();
  private readonly appointments = new Map<string, AppointmentRecord>();
  private readonly appointmentIdByIdempotencyKey = new Map<string, string>(); // `${orgId}:${key}`
  private readonly rateLimits = new Map<string, { windowStartedAt: number; requestCount: number }>();
  private readonly whatsappPhoneNumberIdByOrg = new Map<string, string>();
  private readonly phoneNumberIdToOrg = new Map<string, string>();
  private readonly outbox = new Map<string, InMemoryOutboxRow>();
  // ---- Fase 6 §1 — guardia de crisis ----
  private readonly tenantConfigs = new Map<string, TenantConfigRecord>();
  // ---- Corrección bloqueante ronda 2 del PR #180 — el doble en memoria no
  // tiene catálogo de Postgres que consultar (`to_regprocedure`), así que
  // simula el resultado del probe con esta bandera: `true` por defecto (mismo
  // comportamiento que una base YA migrada, que es lo que asumen todos los
  // demás tests de este repo que no la tocan); los tests que sí necesitan
  // reproducir "esquema a medias" (020/021 no aplicadas) la ponen en `false`
  // vía `setSystemWaitlistFunctionsAvailable` -- ver
  // `repository.ts::areSystemWaitlistFunctionsAvailable` para el diseño real. ----
  private systemWaitlistFunctionsAvailableFlag = true;

  /** Contadores de llamadas a los métodos BATCH de enriquecimiento de agenda --
   * expuestos para que los tests de rendimiento (ver
   * apps/api/tests/citas-admin.spec.ts) verifiquen que `GET .../appointments`
   * ejecuta un número de llamadas al repositorio FIJO, sin importar cuántos
   * proveedores/servicios/clientes DISTINTOS referencien las citas de la página
   * (hallazgo de auditoría, rubro 10 "performance y escalabilidad": "Agenda de citas
   * con 1+P+S+C queries por carga"). No forman parte del contrato `CitasRepository`. */
  llamadasFindProvidersByIds = 0;
  llamadasFindServicesByIds = 0;
  llamadasFindCustomersByIds = 0;
  private readonly emergencyEscalations: EmergencyEscalationRecord[] = [];
  // ---- FASE 3 (producto) -- bitácora de auditoría del staff, ver
  // migrations/023_citas_audit_log.sql. Expuesta (no privada, mismo criterio que
  // `InMemoryRestaurantesRepository.auditLog`) para que un test pueda inspeccionar
  // lo que de verdad se escribió sin pasar por una ruta HTTP de lectura. ----
  readonly auditLog: (CitasAuditLogRow & { readonly organizationId: string; readonly seq: number })[] = [];
  private auditLogSeq = 0;
  // ---- Fase 6 §2 — Cal.com/CalDAV por proveedor ----
  private readonly calcomAccounts = new Map<string, ProviderCalComAccountRecord>(); // por providerId
  private readonly calcomApiKeys = new Map<string, string>(); // por providerId
  private readonly caldavAccounts = new Map<string, ProviderCalDavAccountRecord>(); // por providerId
  private readonly caldavPasswords = new Map<string, string>(); // por providerId
  private readonly waitlist = new Map<string, StoredWaitlistRow>();
  // ---- Fase 3 — Google Calendar (ver diseño §3/§4) ----
  private readonly calendarAccounts = new Map<string, ProviderCalendarAccountRecord>(); // por providerId
  /** Nunca hay Vault real en memoria — el "secreto" es el refresh token en texto
   * plano, guardado aparte del registro público para que un log accidental de
   * `calendarAccounts` no lo incluya (mismo espíritu que Vault, sin Vault real). */
  private readonly calendarRefreshTokens = new Map<string, string>(); // por providerId
  private readonly whatsappEvents = new Map<string, StoredWhatsAppEvent>();
  private readonly whatsappConversations = new Map<string, StoredConversation>();

  private readonly appointmentLock = new KeyedMutex();
  private readonly customerLock = new KeyedMutex();
  private readonly whatsappLock = new KeyedMutex();

  // ---- seeding (equivalente a INSERT manual contra las migraciones SQL) ----

  seedOrganization(org: { id: string; slug: string; name: string; isActive?: boolean; defaultTimezone?: string }): void {
    const stored: StoredOrganization = { id: org.id, slug: org.slug, name: org.name, isActive: org.isActive ?? true, defaultTimezone: org.defaultTimezone ?? "America/Mexico_City" };
    this.organizations.set(org.id, stored);
    this.organizationIdBySlug.set(org.slug, org.id);
  }

  seedPropertyTimezone(propertyId: string, timezone: string): void {
    this.propertyTimezones.set(propertyId, timezone);
  }

  /** Fase 5 §1 — equivalente en memoria de un INSERT en `core.property` (ver
   * `listPropertiesForOrganization`). */
  seedCitasProperty(property: { id: string; organizationId: string; name: string }): void {
    this.citasProperties.set(property.id, { propertyId: property.id, organizationId: property.organizationId, name: property.name });
  }

  seedProvider(provider: ProviderRecord): void {
    this.providers.set(provider.id, provider);
  }

  seedService(service: ServiceRecord): void {
    this.services.set(service.id, service);
  }

  seedProviderService(providerId: string, serviceId: string): void {
    this.providerServices.add(`${providerId}:${serviceId}`);
  }

  seedAvailabilityRule(rule: AvailabilityRule): void {
    const list = this.availabilityRules.get(rule.providerId) ?? [];
    list.push(rule);
    this.availabilityRules.set(rule.providerId, list);
  }

  seedAvailabilityOverride(override: AvailabilityOverride): void {
    this.availabilityOverrides.set(`${override.providerId}:${override.overrideDate}`, override);
  }

  seedWhatsAppConfig(organizationId: string, phoneNumberId: string): void {
    this.whatsappPhoneNumberIdByOrg.set(organizationId, phoneNumberId);
    this.phoneNumberIdToOrg.set(phoneNumberId, organizationId);
  }

  /** Corrección bloqueante ronda 2 del PR #180 — simula "esquema a medias"
   * (`false`, migraciones 020/021 no aplicadas) o base ya migrada (`true`,
   * default) para el probe de `areSystemWaitlistFunctionsAvailable`. */
  setSystemWaitlistFunctionsAvailable(available: boolean): void {
    this.systemWaitlistFunctionsAvailableFlag = available;
  }

  seedWaitlistEntry(row: Omit<StoredWaitlistRow, "id" | "status" | "notifiedCount" | "createdAt" | "expiresAt"> & { id?: string; expiresAt?: string; createdAt?: string }): string {
    const id = row.id ?? randomUUID();
    this.waitlist.set(id, {
      id,
      organizationId: row.organizationId,
      customerPhone: row.customerPhone,
      customerName: row.customerName,
      providerId: row.providerId,
      serviceId: row.serviceId,
      preferredDateFrom: row.preferredDateFrom,
      preferredDateTo: row.preferredDateTo,
      preferredTimeWindow: row.preferredTimeWindow,
      status: "active",
      notifiedCount: 0,
      expiresAt: row.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      // Override real para tests determinísticos de orden FIFO
      // (runListaEsperaCore/runOptimizadorCore) — dos entradas seedeadas en el
      // mismo tick de reloj tendrían el mismo `Date.now()` de otro modo.
      createdAt: row.createdAt ?? new Date().toISOString(),
    });
    return id;
  }

  /** Solo para tests: permite insertar una cita ya existente con un estado/horario
   * concreto (ej. para probar cancelar/reagendar sin pasar por createAppointment). */
  seedAppointment(appointment: AppointmentRecord): void {
    this.appointments.set(appointment.id, appointment);
    if (appointment.idempotencyKey) {
      this.appointmentIdByIdempotencyKey.set(`${appointment.organizationId}:${appointment.idempotencyKey}`, appointment.id);
    }
  }

  getOutbox(): readonly { id: string; organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: unknown; status: string; attempts: number }[] {
    return [...this.outbox.values()];
  }

  /** Solo para tests: seedea `citas.tenant_config` (rubro + timezone + teléfono de
   * aviso) sin pasar por ninguna ruta de panel — equivalente a un INSERT manual. */
  seedTenantConfig(config: { organizationId: string; rubro?: string; defaultTimezone?: string; ownerNotificationPhone?: string | null }): void {
    this.tenantConfigs.set(config.organizationId, {
      organizationId: config.organizationId,
      rubro: config.rubro ?? "otro",
      defaultTimezone: config.defaultTimezone ?? "America/Mexico_City",
      ownerNotificationPhone: config.ownerNotificationPhone ?? null,
    });
  }

  getWaitlistEntry(id: string): StoredWaitlistRow | undefined {
    return this.waitlist.get(id);
  }

  // ---- CitasRepository ----

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const id = this.organizationIdBySlug.get(slug);
    if (!id) return null;
    const org = this.organizations.get(id);
    return org ? { id: org.id, name: org.name, slug: org.slug, isActive: org.isActive } : null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    return [...this.citasProperties.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p) => ({ propertyId: p.propertyId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findPropertyTimezone(propertyId: string | null, organizationId: string): Promise<string> {
    if (propertyId) {
      const tz = this.propertyTimezones.get(propertyId);
      if (tz) return tz;
    }
    // Fase 8 — en Postgres, `citas.tenant_config.default_timezone` es la MISMA
    // columna que edita `upsertTenantConfig` y la que lee esta función (ver
    // postgres-repository.ts); aquí en memoria son dos mapas históricamente
    // separados (`tenantConfigs` seedeado por `seedTenantConfig`/panel,
    // `organizations` seedeado por `seedOrganization`) — se prioriza
    // `tenantConfigs` cuando existe para que editar el timezone desde el panel
    // (Fase 8) sí cambie qué slots calcula `findPropertyTimezone`, con el seed de
    // `seedOrganization` como fallback de compatibilidad para los tests que nunca
    // llamaron `seedTenantConfig`.
    return this.tenantConfigs.get(organizationId)?.defaultTimezone ?? this.organizations.get(organizationId)?.defaultTimezone ?? "America/Mexico_City";
  }

  async findProvider(organizationId: string, providerId: string): Promise<ProviderRecord | null> {
    const provider = this.providers.get(providerId);
    if (!provider || provider.organizationId !== organizationId) return null;
    return provider;
  }

  async findProvidersByIds(organizationId: string, providerIds: readonly string[]): Promise<readonly ProviderRecord[]> {
    this.llamadasFindProvidersByIds += 1;
    const idSet = new Set(providerIds);
    return [...this.providers.values()].filter((p) => p.organizationId === organizationId && idSet.has(p.id));
  }

  async findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null> {
    const service = this.services.get(serviceId);
    if (!service || service.organizationId !== organizationId) return null;
    return service;
  }

  async findServicesByIds(organizationId: string, serviceIds: readonly string[]): Promise<readonly ServiceRecord[]> {
    this.llamadasFindServicesByIds += 1;
    const idSet = new Set(serviceIds);
    return [...this.services.values()].filter((s) => s.organizationId === organizationId && idSet.has(s.id));
  }

  async providerOffersService(providerId: string, serviceId: string): Promise<boolean> {
    return this.providerServices.has(`${providerId}:${serviceId}`);
  }

  async createProvider(input: NewProviderInput): Promise<ProviderRecord> {
    const created: ProviderRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      displayName: input.displayName,
      roleLabel: input.roleLabel ?? "Proveedor",
      isActive: input.isActive ?? true,
    };
    this.providers.set(created.id, created);
    return created;
  }

  async updateProvider(organizationId: string, providerId: string, patch: ProviderPatch): Promise<ProviderRecord | null> {
    const existing = this.providers.get(providerId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: ProviderRecord = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      roleLabel: patch.roleLabel ?? existing.roleLabel,
      propertyId: patch.propertyId !== undefined ? patch.propertyId : existing.propertyId,
      isActive: patch.isActive ?? existing.isActive,
    };
    this.providers.set(providerId, updated);
    return updated;
  }

  async setProviderServiceOffering(providerId: string, serviceId: string, offered: boolean): Promise<void> {
    const key = `${providerId}:${serviceId}`;
    if (offered) this.providerServices.add(key);
    else this.providerServices.delete(key);
  }

  async createService(input: NewServiceInput): Promise<ServiceRecord> {
    const created: ServiceRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      durationMinutes: input.durationMinutes,
      bufferMinutesBefore: input.bufferMinutesBefore ?? 0,
      bufferMinutesAfter: input.bufferMinutesAfter ?? 0,
      priceCents: input.priceCents ?? null,
      isActive: input.isActive ?? true,
    };
    this.services.set(created.id, created);
    return created;
  }

  async updateService(organizationId: string, serviceId: string, patch: ServicePatch): Promise<ServiceRecord | null> {
    const existing = this.services.get(serviceId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: ServiceRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
      bufferMinutesBefore: patch.bufferMinutesBefore ?? existing.bufferMinutesBefore,
      bufferMinutesAfter: patch.bufferMinutesAfter ?? existing.bufferMinutesAfter,
      priceCents: patch.priceCents !== undefined ? patch.priceCents : existing.priceCents,
      isActive: patch.isActive ?? existing.isActive,
    };
    this.services.set(serviceId, updated);
    return updated;
  }

  async loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]> {
    return this.availabilityRules.get(providerId) ?? [];
  }

  async loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null> {
    return this.availabilityOverrides.get(`${providerId}:${dateStr}`) ?? null;
  }

  async listAvailabilityOverrides(providerId: string, fromDateInclusive?: string): Promise<readonly AvailabilityOverride[]> {
    return [...this.availabilityOverrides.values()]
      .filter((o) => o.providerId === providerId && (fromDateInclusive === undefined || o.overrideDate >= fromDateInclusive))
      .sort((a, b) => a.overrideDate.localeCompare(b.overrideDate));
  }

  // ---- Fase 10 — panel admin: CRUD real de horarios/excepciones (mismas
  // restricciones de integridad que 001_citas_schema.sql: `id` generado aquí igual
  // que gen_random_uuid(), ningún método de escritura confía en el caller para el
  // id de una fila nueva). ----
  async createAvailabilityRule(input: NewAvailabilityRuleInput): Promise<AvailabilityRule> {
    const created: AvailabilityRule = {
      id: randomUUID(),
      providerId: input.providerId,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      isActive: input.isActive ?? true,
    };
    const list = this.availabilityRules.get(input.providerId) ?? [];
    list.push(created);
    this.availabilityRules.set(input.providerId, list);
    return created;
  }

  async updateAvailabilityRule(providerId: string, ruleId: string, patch: AvailabilityRulePatch): Promise<AvailabilityRule | null> {
    const list = this.availabilityRules.get(providerId) ?? [];
    const index = list.findIndex((r) => r.id === ruleId);
    if (index === -1) return null;
    const existing = list[index]!;
    const updated: AvailabilityRule = {
      ...existing,
      dayOfWeek: patch.dayOfWeek ?? existing.dayOfWeek,
      startTime: patch.startTime ?? existing.startTime,
      endTime: patch.endTime ?? existing.endTime,
      isActive: patch.isActive ?? existing.isActive,
    };
    list[index] = updated;
    this.availabilityRules.set(providerId, list);
    return updated;
  }

  async deleteAvailabilityRule(providerId: string, ruleId: string): Promise<boolean> {
    const list = this.availabilityRules.get(providerId) ?? [];
    const next = list.filter((r) => r.id !== ruleId);
    this.availabilityRules.set(providerId, next);
    return next.length !== list.length;
  }

  async upsertAvailabilityOverride(input: AvailabilityOverrideInput): Promise<AvailabilityOverride> {
    const override: AvailabilityOverride = {
      providerId: input.providerId,
      overrideDate: input.overrideDate,
      isClosed: input.isClosed,
      startTime: input.isClosed ? null : (input.startTime ?? null),
      endTime: input.isClosed ? null : (input.endTime ?? null),
      reason: input.reason ?? null,
    };
    this.availabilityOverrides.set(`${input.providerId}:${input.overrideDate}`, override);
    return override;
  }

  async deleteAvailabilityOverride(providerId: string, overrideDate: string): Promise<boolean> {
    return this.availabilityOverrides.delete(`${providerId}:${overrideDate}`);
  }

  async loadBusyIntervals(providerId: string, dayStartUtc: string, dayEndUtc: string, excludeAppointmentId?: string): Promise<readonly BusyInterval[]> {
    const startMs = Date.parse(dayStartUtc);
    const endMs = Date.parse(dayEndUtc);
    const busy: BusyInterval[] = [];
    for (const apt of this.appointments.values()) {
      if (apt.providerId !== providerId) continue;
      if (excludeAppointmentId && apt.id === excludeAppointmentId) continue;
      if (!(["pending", "confirmed", "completed"] as const).includes(apt.status as "pending" | "confirmed" | "completed")) continue;
      const aptStart = Date.parse(apt.startsAt);
      const aptEnd = Date.parse(apt.endsAt);
      if (aptStart < endMs && aptEnd > startMs) {
        busy.push({ start: new Date(apt.startsAt), end: new Date(apt.endsAt) });
      }
    }
    return busy;
  }

  async upsertCustomer(organizationId: string, phone: string, name: string, email?: string | null): Promise<CustomerRecord> {
    // Serializado por (organizationId, phone) — equivalente en memoria del UNIQUE
    // real + recuperación de 23505 del origen.
    return this.customerLock.run(`${organizationId}:${phone}`, async () => {
      const key = `${organizationId}:${phone}`;
      const existingId = this.customerIdByOrgPhone.get(key);
      if (existingId) {
        const existing = this.customers.get(existingId)!;
        const updated: CustomerRecord = { ...existing, email: email ?? existing.email };
        this.customers.set(existingId, updated);
        return updated;
      }
      const created: CustomerRecord = { id: randomUUID(), organizationId, fullName: name, phone, email: email ?? null };
      this.customers.set(created.id, created);
      this.customerIdByOrgPhone.set(key, created.id);
      return created;
    });
  }

  async findCustomerByPhone(organizationId: string, phone: string): Promise<CustomerRecord | null> {
    const id = this.customerIdByOrgPhone.get(`${organizationId}:${phone}`);
    if (!id) return null;
    return this.customers.get(id) ?? null;
  }

  async findCustomerById(organizationId: string, customerId: string): Promise<CustomerRecord | null> {
    const customer = this.customers.get(customerId);
    if (!customer || customer.organizationId !== organizationId) return null;
    return customer;
  }

  async findCustomersByIds(organizationId: string, customerIds: readonly string[]): Promise<readonly CustomerRecord[]> {
    this.llamadasFindCustomersByIds += 1;
    const idSet = new Set(customerIds);
    return [...this.customers.values()].filter((c) => c.organizationId === organizationId && idSet.has(c.id));
  }

  async listCustomers(organizationId: string, opts: { readonly limit: number; readonly offset: number; readonly search?: string }): Promise<CustomerPage> {
    const search = opts.search?.trim().toLowerCase();
    const matching = [...this.customers.values()]
      .filter((c) => c.organizationId === organizationId)
      .filter((c) => !search || c.fullName.toLowerCase().includes(search) || c.phone.includes(search))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const page = matching.slice(opts.offset, opts.offset + opts.limit);
    const nextOffset = opts.offset + page.length < matching.length ? opts.offset + page.length : null;
    return { items: page, total: matching.length, nextOffset };
  }

  async updateCustomerEmailFromPanel(organizationId: string, customerId: string, email: string | null): Promise<CustomerRecord | null> {
    const existing = this.customers.get(customerId);
    if (!existing || existing.organizationId !== organizationId) return null;
    const updated: CustomerRecord = { ...existing, email };
    this.customers.set(customerId, updated);
    return updated;
  }

  async listActiveServices(organizationId: string): Promise<readonly ServiceRecord[]> {
    return [...this.services.values()].filter((s) => s.organizationId === organizationId && s.isActive).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listActiveProviders(organizationId: string, serviceId?: string): Promise<readonly ProviderRecord[]> {
    return [...this.providers.values()]
      .filter((p) => p.organizationId === organizationId && p.isActive && (!serviceId || this.providerServices.has(`${p.id}:${serviceId}`)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async listActiveAppointmentsForCustomer(organizationId: string, customerId: string, nowIso: string): Promise<readonly AppointmentRecord[]> {
    const nowMs = Date.parse(nowIso);
    return [...this.appointments.values()]
      .filter(
        (a) =>
          a.organizationId === organizationId &&
          a.customerId === customerId &&
          (a.status === "pending" || a.status === "confirmed") &&
          Date.parse(a.startsAt) >= nowMs,
      )
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  }

  async createAppointmentIdempotent(input: NewAppointmentInput, dedupeFingerprint: string, idempotencyKey: string | null): Promise<CreateAppointmentResult> {
    return this.appointmentLock.run(`${input.organizationId}:${idempotencyKey ?? dedupeFingerprint}`, async () => {
      if (idempotencyKey) {
        const existingId = this.appointmentIdByIdempotencyKey.get(`${input.organizationId}:${idempotencyKey}`);
        if (existingId) {
          const existing = this.appointments.get(existingId)!;
          // Misma llave, contenido DISTINTO -> conflicto real (mismo comportamiento
          // que el sqlstate AT409/PT409 real).
          if (existing.dedupeFingerprint !== dedupeFingerprint) {
            return { outcome: "conflict_idempotency_reused" };
          }
          return { outcome: "existing", appointment: existing };
        }
      } else {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const existing = [...this.appointments.values()].find(
          (a) => a.organizationId === input.organizationId && a.dedupeFingerprint === dedupeFingerprint && (a.status === "pending" || a.status === "confirmed") && Date.parse(a.createdAt) >= fiveMinutesAgo,
        );
        if (existing) return { outcome: "existing", appointment: existing };
      }

      // EXCLUDE USING gist real: ningún proveedor puede tener dos citas activas que
      // se traslapen en el tiempo — capa 1 de anti-doble-reserva (ver diseño §0.7).
      const newStart = Date.parse(input.startsAt);
      const newEnd = Date.parse(input.endsAt);
      const conflict = [...this.appointments.values()].some(
        (a) => a.providerId === input.providerId && (["pending", "confirmed", "completed"] as const).includes(a.status as "pending" | "confirmed" | "completed") && overlapsRange(Date.parse(a.startsAt), Date.parse(a.endsAt), newStart, newEnd),
      );
      if (conflict) return { outcome: "conflict_slot_taken" };

      const created: AppointmentRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        providerId: input.providerId,
        serviceId: input.serviceId,
        customerId: input.customerId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: input.status,
        source: input.source,
        notes: input.notes,
        dedupeFingerprint,
        idempotencyKey,
        reminder24hSentAt: null,
        createdAt: new Date().toISOString(),
        // Fase 3 §3: toda cita nueva nace elegible de inmediato para sincronizar —
        // el motor de sincronización decide "skipped" si el proveedor no tiene
        // Google Calendar conectado (nunca se decide aquí, en el punto de creación).
        googleEventId: null,
        googleSyncStatus: "pending",
        googleSyncAttempts: 0,
        googleSyncNextRetryAt: null,
        googleSyncError: null,
      };
      this.appointments.set(created.id, created);
      if (idempotencyKey) this.appointmentIdByIdempotencyKey.set(`${input.organizationId}:${idempotencyKey}`, created.id);
      return { outcome: "created", appointment: created };
    });
  }

  // ---- Fase 12 -- alta real de una cita desde el panel de staff (ver
  // CreateFromPanelResult/postgres-repository.ts para el detalle completo). El
  // fake NUNCA simula membership/property scoping (el resto de este archivo
  // tampoco lo hace para cancel/confirm/complete/no-show -- ver esos métodos más
  // abajo: `_actorUserId` sin usar) -- esa autorización es responsabilidad
  // EXCLUSIVA de la RLS/RPC de Postgres real (migrations/015), nunca del fake de
  // pruebas de negocio. Mismo candado + mismo EXCLUDE-equivalente que
  // createAppointmentIdempotent de arriba.
  async createAppointmentFromPanel(input: NewAppointmentFromPanelInput): Promise<CreateFromPanelResult> {
    return this.appointmentLock.run(`create-panel:${input.organizationId}:${input.providerId}`, async () => {
      const newStart = Date.parse(input.startsAt);
      const newEnd = Date.parse(input.endsAt);
      const conflict = [...this.appointments.values()].some(
        (a) => a.providerId === input.providerId && (["pending", "confirmed", "completed"] as const).includes(a.status as "pending" | "confirmed" | "completed") && overlapsRange(Date.parse(a.startsAt), Date.parse(a.endsAt), newStart, newEnd),
      );
      if (conflict) return { outcome: "conflict_slot_taken" };

      const customer = await this.upsertCustomer(input.organizationId, input.customerPhone, input.customerName, input.customerEmail);

      const created: AppointmentRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        providerId: input.providerId,
        serviceId: input.serviceId,
        customerId: customer.id,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: "pending",
        source: "manual",
        notes: input.notes,
        dedupeFingerprint: null,
        idempotencyKey: null,
        reminder24hSentAt: null,
        createdAt: new Date().toISOString(),
        googleEventId: null,
        googleSyncStatus: "pending",
        googleSyncAttempts: 0,
        googleSyncNextRetryAt: null,
        googleSyncError: null,
      };
      this.appointments.set(created.id, created);
      return { outcome: "created", appointment: created };
    });
  }

  async findAppointmentForOrganization(organizationId: string, appointmentId: string): Promise<AppointmentRecord | null> {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment || appointment.organizationId !== organizationId) return null;
    return appointment;
  }

  async listAppointmentsInRange(organizationId: string, fromIso: string, toIso: string, providerId: string | undefined, limit: number): Promise<readonly AppointmentRecord[]> {
    const fromMs = Date.parse(fromIso);
    const toMs = Date.parse(toIso);
    return [...this.appointments.values()]
      .filter((a) => a.organizationId === organizationId && (!providerId || a.providerId === providerId))
      .filter((a) => {
        const startsMs = Date.parse(a.startsAt);
        return startsMs >= fromMs && startsMs < toMs;
      })
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .slice(0, limit);
  }

  private cancelInternal(organizationId: string, appointmentId: string): CancelResult {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };

    if (appointment.status === "cancelled") return { outcome: "already_cancelled", appointment };
    if (appointment.status === "completed" || appointment.status === "no_show") {
      return { outcome: "conflict_invalid_status", status: appointment.status };
    }

    // Fase 3 §3/§5: transición ATÓMICA (misma "operación" que el cancel real, sin
    // segunda pasada) a 'pending_cancel' si ya había un evento en Google que borrar,
    // o 'skipped' si esta cita nunca llegó a sincronizarse (nunca dejarla en
    // 'pending' — si no se toca, el cron intentaría CREAR un evento para una cita ya
    // cancelada). Reinicia el contador de intentos/backoff: es, en efecto, una
    // intención de sincronización nueva.
    const nextGoogleSyncStatus: GoogleSyncStatus = appointment.googleEventId ? "pending_cancel" : "skipped";
    const updated: AppointmentRecord = {
      ...appointment,
      status: "cancelled",
      googleSyncStatus: nextGoogleSyncStatus,
      googleSyncAttempts: 0,
      googleSyncNextRetryAt: null,
      googleSyncError: null,
    };
    this.appointments.set(appointmentId, updated);
    return { outcome: "cancelled", appointment: updated };
  }

  async cancelAppointmentIdempotent(organizationId: string, appointmentId: string): Promise<CancelResult> {
    return this.appointmentLock.run(`cancel:${organizationId}:${appointmentId}`, async () => this.cancelInternal(organizationId, appointmentId));
  }

  async cancelAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<CancelResult> {
    return this.appointmentLock.run(`cancel:${organizationId}:${appointmentId}`, async () => this.cancelInternal(organizationId, appointmentId));
  }

  // ---- Fase 7 -- confirmar/completar/marcar no-show desde el panel de staff.
  // Mismas 3 restricciones de integridad que la RPC real de
  // migrations/010_appointment_status_transitions.sql: candado por clave
  // (equivalente en memoria del `for update` de Postgres), no-op idempotente si ya
  // está en el estado destino, conflicto si el estado actual no admite la
  // transición. ----

  async confirmAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<ConfirmResult> {
    return this.appointmentLock.run(`confirm:${organizationId}:${appointmentId}`, async () => {
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.status === "confirmed") return { outcome: "already_confirmed", appointment };
      if (appointment.status !== "pending") return { outcome: "conflict_invalid_status", status: appointment.status };

      const updated: AppointmentRecord = { ...appointment, status: "confirmed" };
      this.appointments.set(appointmentId, updated);
      return { outcome: "confirmed", appointment: updated };
    });
  }

  async completeAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<CompleteResult> {
    return this.appointmentLock.run(`complete:${organizationId}:${appointmentId}`, async () => {
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.status === "completed") return { outcome: "already_completed", appointment };
      if (appointment.status !== "pending" && appointment.status !== "confirmed") {
        return { outcome: "conflict_invalid_status", status: appointment.status };
      }

      const updated: AppointmentRecord = { ...appointment, status: "completed" };
      this.appointments.set(appointmentId, updated);
      return { outcome: "completed", appointment: updated };
    });
  }

  async markAppointmentNoShowFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<NoShowResult> {
    return this.appointmentLock.run(`no-show:${organizationId}:${appointmentId}`, async () => {
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.status === "no_show") return { outcome: "already_no_show", appointment };
      if (appointment.status !== "pending" && appointment.status !== "confirmed") {
        return { outcome: "conflict_invalid_status", status: appointment.status };
      }

      const updated: AppointmentRecord = { ...appointment, status: "no_show" };
      this.appointments.set(appointmentId, updated);
      return { outcome: "marked_no_show", appointment: updated };
    });
  }

  // Fase 6 §2 (seguimiento) — "reintentar sincronización" del panel: mismo
  // candado + mismo criterio not_found/conflict_invalid_status que
  // confirm/complete/no-show de arriba. Solo transiciona una cita realmente
  // 'invalid' -- cualquier otro estado (incluido 'error', 'pending', etc.) es
  // conflict_invalid_status, nunca un no-op silencioso que confunda al staff
  // sobre si el reintento de verdad hizo algo.
  async retryAppointmentCalendarSyncFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<RetryCalendarSyncResult> {
    return this.appointmentLock.run(`retry-sync:${organizationId}:${appointmentId}`, async () => {
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.googleSyncStatus !== "invalid") {
        return { outcome: "conflict_invalid_status", status: appointment.googleSyncStatus };
      }

      const updated: AppointmentRecord = { ...appointment, googleSyncStatus: "pending", googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null };
      this.appointments.set(appointmentId, updated);
      return { outcome: "retried", appointment: updated };
    });
  }

  async rescheduleAppointmentIdempotent(organizationId: string, appointmentId: string, newStartsAt: string, newEndsAt: string, actorChannel: AppointmentActorChannel, _actorNote: string | null): Promise<RescheduleResult> {
    return this.appointmentLock.run(`reschedule:${organizationId}:${appointmentId}`, async () => {
      void actorChannel;
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.status !== "pending" && appointment.status !== "confirmed") {
        return { outcome: "conflict_invalid_status", status: appointment.status };
      }

      // Reintento del mismo intento (mismo horario destino ya vigente): no-op
      // idempotente real.
      if (appointment.startsAt === newStartsAt && appointment.endsAt === newEndsAt) {
        return { outcome: "noop_same_slot", appointment };
      }

      const newStart = Date.parse(newStartsAt);
      const newEnd = Date.parse(newEndsAt);
      const conflict = [...this.appointments.values()].some(
        (a) =>
          a.id !== appointmentId &&
          a.providerId === appointment.providerId &&
          (["pending", "confirmed", "completed"] as const).includes(a.status as "pending" | "confirmed" | "completed") &&
          overlapsRange(Date.parse(a.startsAt), Date.parse(a.endsAt), newStart, newEnd),
      );
      if (conflict) return { outcome: "conflict_slot_taken" };

      // Fase 3 §3/§5: si ya había un evento sincronizado en Google, reagendar debe
      // volver a empujarlo (nunca queda "olvidado" con el horario viejo) — se
      // reinicia el backoff porque es, en efecto, un intento de sincronización
      // nuevo. Si nunca tuvo evento (todavía 'pending' o 'skipped' sin conectar),
      // se deja tal cual: la fila ya trae el horario nuevo, así que cuando sí
      // sincronice lo hará con el dato correcto sin necesitar ningún cambio aquí.
      const updated: AppointmentRecord = {
        ...appointment,
        startsAt: newStartsAt,
        endsAt: newEndsAt,
        reminder24hSentAt: null,
        ...(appointment.googleEventId ? { googleSyncStatus: "pending" as GoogleSyncStatus, googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null } : {}),
      };
      this.appointments.set(appointmentId, updated);
      return { outcome: "rescheduled", appointment: updated };
    });
  }

  async reassignAppointmentIdempotent(organizationId: string, appointmentId: string, newProviderId: string, newServiceId: string, newEndsAt: string, actorChannel: AppointmentActorChannel, _actorNote: string | null): Promise<ReassignResult> {
    return this.appointmentLock.run(`reassign:${organizationId}:${appointmentId}`, async () => {
      void actorChannel;
      const appointment = this.appointments.get(appointmentId);
      if (!appointment || appointment.organizationId !== organizationId) return { outcome: "not_found" };
      if (appointment.status !== "pending" && appointment.status !== "confirmed") {
        return { outcome: "conflict_invalid_status", status: appointment.status };
      }

      // Reintento del mismo intento (mismo proveedor/servicio/ends_at ya
      // vigentes): no-op idempotente real.
      if (appointment.providerId === newProviderId && appointment.serviceId === newServiceId && appointment.endsAt === newEndsAt) {
        return { outcome: "noop_same_assignment", appointment };
      }

      // El conflicto se revisa contra el PROVEEDOR NUEVO -- mismo criterio que el
      // `exclude using gist (provider_id with =, ...)` real de Postgres, que
      // revalida automáticamente porque el UPDATE real toca `provider_id`.
      const newStart = Date.parse(appointment.startsAt);
      const newEnd = Date.parse(newEndsAt);
      const conflict = [...this.appointments.values()].some(
        (a) =>
          a.id !== appointmentId &&
          a.providerId === newProviderId &&
          (["pending", "confirmed", "completed"] as const).includes(a.status as "pending" | "confirmed" | "completed") &&
          overlapsRange(Date.parse(a.startsAt), Date.parse(a.endsAt), newStart, newEnd),
      );
      if (conflict) return { outcome: "conflict_slot_taken" };

      const updated: AppointmentRecord = {
        ...appointment,
        providerId: newProviderId,
        serviceId: newServiceId,
        endsAt: newEndsAt,
        reminder24hSentAt: null,
        ...(appointment.googleEventId ? { googleSyncStatus: "pending" as GoogleSyncStatus, googleSyncAttempts: 0, googleSyncNextRetryAt: null, googleSyncError: null } : {}),
      };
      this.appointments.set(appointmentId, updated);
      return { outcome: "reassigned", appointment: updated };
    });
  }

  async listActiveOrganizations(): Promise<readonly { id: string; timezone: string }[]> {
    return [...this.organizations.values()].filter((o) => o.isActive).map((o) => ({ id: o.id, timezone: o.defaultTimezone }));
  }

  async loadAppointmentsPendingReminder(organizationId: string, windowStartIso: string, windowEndIso: string): Promise<readonly ReminderCandidateRow[]> {
    const startMs = Date.parse(windowStartIso);
    const endMs = Date.parse(windowEndIso);
    const rows: ReminderCandidateRow[] = [];
    for (const apt of this.appointments.values()) {
      if (apt.organizationId !== organizationId) continue;
      if (apt.status !== "pending" && apt.status !== "confirmed") continue;
      if (apt.reminder24hSentAt) continue;
      const startsMs = Date.parse(apt.startsAt);
      if (startsMs < startMs || startsMs > endMs) continue;
      const customer = this.customers.get(apt.customerId);
      rows.push({ appointmentId: apt.id, providerId: apt.providerId, startsAt: apt.startsAt, customerName: customer?.fullName ?? null, customerPhone: customer?.phone ?? "" });
    }
    return rows;
  }

  async markReminderSent(appointmentId: string, sentAtIso: string): Promise<void> {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment) return;
    this.appointments.set(appointmentId, { ...appointment, reminder24hSentAt: sentAtIso });
  }

  async resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null> {
    return this.whatsappPhoneNumberIdByOrg.get(organizationId) ?? null;
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    const existing = [...this.outbox.values()].find((o) => o.organizationId === organizationId && o.channel === channel && o.dedupeKey === dedupeKey);
    if (existing) {
      // Mismo criterio que `citas.enqueue_messaging_outbox` real: solo se
      // actualiza el payload si todavía no se procesó (pending/failed) — un
      // mensaje ya sent/processing/dead no se pisa.
      if (existing.status === "pending" || existing.status === "failed") {
        existing.eventType = eventType;
        existing.payload = payload;
      }
      return;
    }
    const id = randomUUID();
    this.outbox.set(id, { id, organizationId, channel, eventType, dedupeKey, payload, status: "pending", attempts: 0, claimedAt: null, nextAttemptAt: 0, lastErrorClass: null, lastError: null });
  }

  async claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]> {
    const now = Date.now();
    const eligible = [...this.outbox.values()]
      .filter(
        (o) =>
          o.channel === "whatsapp" &&
          ((o.status === "pending" && o.nextAttemptAt <= now) || (o.status === "processing" && (o.claimedAt ?? 0) < now - leaseSeconds * 1000)),
      )
      .slice(0, limit);
    for (const row of eligible) {
      row.status = "processing";
      row.claimedAt = now;
    }
    return eligible.map((row) => ({ id: row.id, attempts: row.attempts, payload: row.payload }));
  }

  async markMessagingOutboxSent(id: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "sent";
  }

  async markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "pending";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.nextAttemptAt = Date.parse(nextAttemptAtIso);
    row.claimedAt = null;
  }

  async markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    const row = this.outbox.get(id);
    if (!row || row.status !== "processing") return;
    row.status = "dead";
    row.attempts = attempts;
    row.lastErrorClass = errorClass.slice(0, 120);
    row.claimedAt = null;
  }

  async loadLiveWaitlistCandidates(organizationId: string): Promise<readonly WaitlistCandidateRow[]> {
    const now = Date.now();
    return [...this.waitlist.values()]
      .filter((row) => row.organizationId === organizationId && row.status === "active" && Date.parse(row.expiresAt) > now && row.notifiedCount < 3)
      .map((row) => ({
        id: row.id,
        customerPhone: row.customerPhone,
        customerName: row.customerName,
        notifiedCount: row.notifiedCount,
        providerId: row.providerId,
        serviceId: row.serviceId,
        preferredDateFrom: row.preferredDateFrom,
        preferredDateTo: row.preferredDateTo,
        preferredTimeWindow: row.preferredTimeWindow,
        createdAt: row.createdAt,
      }));
  }

  /** f2-citas-lista-de-espera — el doble en memoria no tiene RLS que simular:
   * misma implementación que `loadLiveWaitlistCandidates` (ver el comentario
   * largo de `repository.ts` para por qué Postgres real sí distingue las dos). */
  async loadLiveWaitlistCandidatesAsSystem(organizationId: string): Promise<readonly WaitlistCandidateRow[]> {
    return this.loadLiveWaitlistCandidates(organizationId);
  }

  /** Corrección post-revisión de f2-citas-lista-de-espera — el doble en
   * memoria no tiene RLS que simular: misma implementación que
   * `resolveActiveWhatsAppPhoneNumberId` (ver el comentario largo de
   * `repository.ts` para por qué Postgres real sí distingue las dos). */
  async resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId: string): Promise<string | null> {
    return this.resolveActiveWhatsAppPhoneNumberId(organizationId);
  }

  /** Corrección bloqueante ronda 2 del PR #180 — ver
   * `repository.ts::areSystemWaitlistFunctionsAvailable` y
   * `setSystemWaitlistFunctionsAvailable` de arriba. */
  async areSystemWaitlistFunctionsAvailable(): Promise<boolean> {
    return this.systemWaitlistFunctionsAvailableFlag;
  }

  async claimWaitlistNotificationSlot(waitlistId: string, maxNotifications: number): Promise<boolean> {
    const row = this.waitlist.get(waitlistId);
    if (!row || row.status !== "active" || row.notifiedCount >= maxNotifications) return false;
    row.notifiedCount += 1;
    return true;
  }

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const key = `${scope}:${actorHash}`;
    const now = Date.now();
    const existing = this.rateLimits.get(key);
    if (!existing || now - existing.windowStartedAt >= windowSeconds * 1000) {
      this.rateLimits.set(key, { windowStartedAt: now, requestCount: 1 });
      return 1 <= maxRequests;
    }
    existing.requestCount += 1;
    return existing.requestCount <= maxRequests;
  }

  // ---- Fase 2 §2.6 — plomería de WhatsApp (dedupe + historial). La lease de
  // conversación (mensajes casi-simultáneos del mismo teléfono) NO vive aquí —
  // ver whatsapp/inbound.ts, que envuelve el turno completo en
  // @atiende/core-conversation::withConversationLock. ----

  async resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    return this.phoneNumberIdToOrg.get(phoneNumberId) ?? null;
  }

  /** f2-citas-whatsapp-config-sesion-sistema — el doble en memoria no tiene
   * RLS que simular: misma implementación que `resolveOrganizationByPhoneNumberId`
   * (ver el comentario largo de `repository.ts` para por qué Postgres real sí
   * distingue las dos). */
  async resolveOrganizationByPhoneNumberIdAsSystem(phoneNumberId: string): Promise<string | null> {
    return this.resolveOrganizationByPhoneNumberId(phoneNumberId);
  }

  async claimWhatsAppMessage(organizationId: string, messageId: string, _phoneHash: string): Promise<boolean> {
    void organizationId;
    return this.whatsappLock.run(`event:${messageId}`, async () => {
      const existing = this.whatsappEvents.get(messageId);
      const now = Date.now();
      if (!existing) {
        this.whatsappEvents.set(messageId, { status: "processing", attempts: 1, claimedAt: now });
        return true;
      }
      const reclaimable = existing.status === "failed" || (existing.status === "processing" && now - existing.claimedAt > 5 * 60 * 1000);
      if (!reclaimable) return false;
      existing.status = "processing";
      existing.attempts += 1;
      existing.claimedAt = now;
      return true;
    });
  }

  async appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]> {
    return this.whatsappAppendTurn(organizationId, phone, [message], null, null, null);
  }

  async whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    appointmentId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]> {
    const key = `${organizationId}:${phone}`;
    // Serializado por (organizationId, phone) — equivalente en memoria del row lock
    // de Postgres que serializa `messages = messages || nuevos`.
    return this.whatsappLock.run(`conv:${key}`, async () => {
      const existing = this.whatsappConversations.get(key) ?? { messages: [], status: "active" as const, appointmentId: null, propertyId: null };
      const updated: StoredConversation = {
        messages: [...existing.messages, ...newMessages],
        status: status ?? existing.status,
        appointmentId: appointmentId ?? existing.appointmentId,
        propertyId: propertyId ?? existing.propertyId,
      };
      this.whatsappConversations.set(key, updated);
      return updated.messages;
    });
  }

  async finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void> {
    void organizationId;
    void phoneHash;
    void errorClass;
    const event = this.whatsappEvents.get(messageId);
    if (event) event.status = status;
  }

  async markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void> {
    void organizationId;
    void errorClass;
    const event = this.whatsappEvents.get(messageId);
    if (event) event.status = "failed";
  }

  // ============================================================================
  // Fase 3 — sincronización con Google Calendar (ver diseño §3/§4/§5)
  // ============================================================================

  /** Solo para tests: conecta un proveedor directo, sin pasar por el flujo OAuth
   * completo — equivalente a un seed manual contra `provider_calendar_accounts`. */
  seedProviderCalendarAccount(input: { organizationId: string; providerId: string; googleCalendarId?: string; refreshToken?: string; syncStatus?: ProviderCalendarAccountRecord["syncStatus"] }): void {
    const now = new Date().toISOString();
    this.calendarAccounts.set(input.providerId, {
      id: randomUUID(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      googleCalendarId: input.googleCalendarId ?? "primary",
      googleWatchChannelId: null,
      googleWatchResourceId: null,
      googleWatchExpiresAt: null,
      syncStatus: input.syncStatus ?? "connected",
      syncError: null,
      createdAt: now,
      updatedAt: now,
    });
    if (input.refreshToken) this.calendarRefreshTokens.set(input.providerId, input.refreshToken);
  }

  async findProviderCalendarAccount(providerId: string): Promise<ProviderCalendarAccountRecord | null> {
    return this.calendarAccounts.get(providerId) ?? null;
  }

  async connectProviderCalendarAccount(input: ConnectProviderCalendarAccountInput): Promise<ProviderCalendarAccountRecord> {
    const existing = this.calendarAccounts.get(input.providerId);
    const now = new Date().toISOString();
    const record: ProviderCalendarAccountRecord = {
      id: existing?.id ?? randomUUID(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      googleCalendarId: input.googleCalendarId,
      googleWatchChannelId: existing?.googleWatchChannelId ?? null,
      googleWatchResourceId: existing?.googleWatchResourceId ?? null,
      googleWatchExpiresAt: existing?.googleWatchExpiresAt ?? null,
      syncStatus: "connected",
      syncError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.calendarAccounts.set(input.providerId, record);
    this.calendarRefreshTokens.set(input.providerId, input.refreshToken);
    return record;
  }

  async rotateProviderCalendarRefreshToken(providerId: string, refreshToken: string): Promise<void> {
    this.calendarRefreshTokens.set(providerId, refreshToken);
  }

  async resolveProviderCalendarRefreshToken(providerId: string): Promise<string | null> {
    return this.calendarRefreshTokens.get(providerId) ?? null;
  }

  async setProviderCalendarAccountSyncError(providerId: string, error: string): Promise<void> {
    const existing = this.calendarAccounts.get(providerId);
    if (!existing) return;
    this.calendarAccounts.set(providerId, { ...existing, syncStatus: "error", syncError: error, updatedAt: new Date().toISOString() });
  }

  private toAppointmentSyncRow(appointment: AppointmentRecord): AppointmentSyncRow {
    const service = this.services.get(appointment.serviceId);
    const customer = this.customers.get(appointment.customerId);
    return {
      id: appointment.id,
      organizationId: appointment.organizationId,
      providerId: appointment.providerId,
      serviceName: service?.name ?? null,
      customerName: customer?.fullName ?? null,
      customerPhone: customer?.phone ?? null,
      customerEmail: customer?.email ?? null,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      notes: appointment.notes,
      // Resuelto de forma síncrona porque el timezone efectivo ya vive en memoria
      // (mismo criterio que findPropertyTimezone) — nunca inventa "UTC" en silencio.
      timeZone: this.propertyTimezones.get(this.providers.get(appointment.providerId)?.propertyId ?? "") ?? this.organizations.get(appointment.organizationId)?.defaultTimezone ?? "America/Mexico_City",
      googleEventId: appointment.googleEventId,
      googleSyncStatus: appointment.googleSyncStatus,
      googleSyncAttempts: appointment.googleSyncAttempts,
    };
  }

  async loadAppointmentSyncRow(appointmentId: string): Promise<AppointmentSyncRow | null> {
    const appointment = this.appointments.get(appointmentId);
    return appointment ? this.toAppointmentSyncRow(appointment) : null;
  }

  async loadPendingGoogleSyncAppointments(limit: number, nowIso: string): Promise<readonly AppointmentSyncRow[]> {
    const nowMs = Date.parse(nowIso);
    return [...this.appointments.values()]
      .filter((a) => {
        if (a.googleSyncStatus !== "pending" && a.googleSyncStatus !== "pending_cancel") return false;
        if (a.googleSyncAttempts >= MAX_SYNC_ATTEMPTS) return false;
        // null = nunca se intentó todavía -> elegible de inmediato (ver diseño §5/§8).
        return a.googleSyncNextRetryAt === null || Date.parse(a.googleSyncNextRetryAt) <= nowMs;
      })
      .sort((a, b) => (Date.parse(a.googleSyncNextRetryAt ?? a.createdAt) || 0) - (Date.parse(b.googleSyncNextRetryAt ?? b.createdAt) || 0))
      .slice(0, limit)
      .map((a) => this.toAppointmentSyncRow(a));
  }

  // No-op real: sin una transacción/conexión Postgres real que proteger, no hay
  // nada que aislar con un SAVEPOINT -- ver el comentario de cabecera de
  // `runWithRowSavepoint` en `repository.ts`. `fn` corre directo y su error (si lo
  // hay) se repropaga tal cual, mismo comportamiento observable que tendría un
  // SAVEPOINT+ROLLBACK TO SAVEPOINT real desde el punto de vista del caller.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private updateAppointmentSyncFields(appointmentId: string, patch: Partial<Pick<AppointmentRecord, "googleEventId" | "googleSyncStatus" | "googleSyncAttempts" | "googleSyncNextRetryAt" | "googleSyncError">>): void {
    const appointment = this.appointments.get(appointmentId);
    if (!appointment) return;
    this.appointments.set(appointmentId, { ...appointment, ...patch });
  }

  async markAppointmentGoogleSynced(appointmentId: string, googleEventId: string, attempts: number): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleEventId, googleSyncStatus: "synced", googleSyncAttempts: attempts, googleSyncNextRetryAt: null, googleSyncError: null });
  }

  async markAppointmentGoogleSyncDeleted(appointmentId: string, attempts: number): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleSyncStatus: "deleted", googleSyncAttempts: attempts, googleSyncNextRetryAt: null, googleSyncError: null });
  }

  async markAppointmentGoogleSyncSkipped(appointmentId: string): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleSyncStatus: "skipped", googleSyncNextRetryAt: null, googleSyncError: null });
  }

  async markAppointmentGoogleSyncRetry(appointmentId: string, attempts: number, error: string, nextRetryAtIso: string): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleSyncAttempts: attempts, googleSyncError: error, googleSyncNextRetryAt: nextRetryAtIso });
  }

  async markAppointmentGoogleSyncExhausted(appointmentId: string, attempts: number, error: string): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleSyncStatus: "error", googleSyncAttempts: attempts, googleSyncError: error, googleSyncNextRetryAt: null });
  }

  async markAppointmentGoogleSyncInvalid(appointmentId: string, attempts: number, reason: string): Promise<void> {
    this.updateAppointmentSyncFields(appointmentId, { googleSyncStatus: "invalid", googleSyncAttempts: attempts, googleSyncError: reason, googleSyncNextRetryAt: null });
  }

  async loadProviderCalendarSyncIssues(providerId: string): Promise<CalendarSyncIssuesSummary> {
    // Más reciente primero por `createdAt` -- ver la nota de diseño de
    // `CalendarSyncIssuesSummary` (repository.ts): "más reciente" aquí es "la cita
    // creada más recientemente", no "el rechazo más reciente" (esta capa no guarda
    // un timestamp propio de cuándo se marcó 'invalid').
    const invalidOnes = [...this.appointments.values()]
      .filter((a) => a.providerId === providerId && a.googleSyncStatus === "invalid")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { count: invalidOnes.length, lastReason: invalidOnes[0]?.googleSyncError ?? null };
  }

  // ============================================================================
  // Fase 6 §1 — guardia de crisis
  // ============================================================================

  async findTenantConfig(organizationId: string): Promise<TenantConfigRecord | null> {
    return this.tenantConfigs.get(organizationId) ?? null;
  }

  async upsertTenantConfig(organizationId: string, patch: TenantConfigPatch): Promise<TenantConfigRecord> {
    const existing = this.tenantConfigs.get(organizationId) ?? { organizationId, rubro: "otro", defaultTimezone: "America/Mexico_City", ownerNotificationPhone: null };
    const updated: TenantConfigRecord = {
      organizationId,
      rubro: patch.rubro ?? existing.rubro,
      defaultTimezone: patch.defaultTimezone ?? existing.defaultTimezone,
      ownerNotificationPhone: patch.ownerNotificationPhone !== undefined ? patch.ownerNotificationPhone : existing.ownerNotificationPhone,
    };
    this.tenantConfigs.set(organizationId, updated);
    return updated;
  }

  async insertEmergencyEscalation(input: EmergencyEscalationInput): Promise<EmergencyEscalationRecord> {
    const record: EmergencyEscalationRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      customerPhone: input.customerPhone,
      channel: input.channel,
      keywordMatched: input.keywordMatched,
      messageExcerpt: input.messageExcerpt,
      createdAt: new Date().toISOString(),
    };
    this.emergencyEscalations.push(record);
    return record;
  }

  /** Solo para tests: lee las escalaciones registradas (equivalente a un SELECT
   * manual contra `citas.emergency_escalations`). */
  getEmergencyEscalations(): readonly EmergencyEscalationRecord[] {
    return this.emergencyEscalations;
  }

  async findOrganizationById(organizationId: string): Promise<{ readonly id: string; readonly name: string } | null> {
    const org = this.organizations.get(organizationId);
    return org ? { id: org.id, name: org.name } : null;
  }

  // ============================================================================
  // Fase 6 §2 — Cal.com/CalDAV por proveedor
  // ============================================================================

  async findProviderCalComAccount(providerId: string): Promise<ProviderCalComAccountRecord | null> {
    return this.calcomAccounts.get(providerId) ?? null;
  }

  async connectProviderCalComAccount(input: ConnectProviderCalComAccountInput): Promise<ProviderCalComAccountRecord> {
    const existing = this.calcomAccounts.get(input.providerId);
    const now = new Date().toISOString();
    const record: ProviderCalComAccountRecord = {
      id: existing?.id ?? randomUUID(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      calcomEventTypeId: input.calcomEventTypeId,
      baseUrl: input.baseUrl ?? null,
      syncStatus: "connected",
      syncError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.calcomAccounts.set(input.providerId, record);
    this.calcomApiKeys.set(input.providerId, input.apiKey);
    return record;
  }

  async disconnectProviderCalComAccount(providerId: string): Promise<void> {
    const existing = this.calcomAccounts.get(providerId);
    if (!existing) return;
    this.calcomAccounts.set(providerId, { ...existing, syncStatus: "disconnected" as CalendarProviderSyncStatus, syncError: null, updatedAt: new Date().toISOString() });
  }

  async resolveProviderCalComApiKey(providerId: string): Promise<string | null> {
    return this.calcomApiKeys.get(providerId) ?? null;
  }

  async setProviderCalComAccountSyncError(providerId: string, error: string): Promise<void> {
    const existing = this.calcomAccounts.get(providerId);
    if (!existing) return;
    this.calcomAccounts.set(providerId, { ...existing, syncStatus: "error", syncError: error, updatedAt: new Date().toISOString() });
  }

  async markProviderCalComAccountSyncOk(providerId: string): Promise<void> {
    const existing = this.calcomAccounts.get(providerId);
    if (!existing || existing.syncStatus === "disconnected") return;
    this.calcomAccounts.set(providerId, { ...existing, syncStatus: "connected", syncError: null, updatedAt: new Date().toISOString() });
  }

  async findProviderCalDavAccount(providerId: string): Promise<ProviderCalDavAccountRecord | null> {
    return this.caldavAccounts.get(providerId) ?? null;
  }

  async connectProviderCalDavAccount(input: ConnectProviderCalDavAccountInput): Promise<ProviderCalDavAccountRecord> {
    const existing = this.caldavAccounts.get(input.providerId);
    const now = new Date().toISOString();
    const record: ProviderCalDavAccountRecord = {
      id: existing?.id ?? randomUUID(),
      organizationId: input.organizationId,
      providerId: input.providerId,
      calendarCollectionUrl: input.calendarCollectionUrl,
      username: input.username,
      syncStatus: "connected",
      syncError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.caldavAccounts.set(input.providerId, record);
    this.caldavPasswords.set(input.providerId, input.password);
    return record;
  }

  async disconnectProviderCalDavAccount(providerId: string): Promise<void> {
    const existing = this.caldavAccounts.get(providerId);
    if (!existing) return;
    this.caldavAccounts.set(providerId, { ...existing, syncStatus: "disconnected" as CalendarProviderSyncStatus, syncError: null, updatedAt: new Date().toISOString() });
  }

  async resolveProviderCalDavPassword(providerId: string): Promise<string | null> {
    return this.caldavPasswords.get(providerId) ?? null;
  }

  async setProviderCalDavAccountSyncError(providerId: string, error: string): Promise<void> {
    const existing = this.caldavAccounts.get(providerId);
    if (!existing) return;
    this.caldavAccounts.set(providerId, { ...existing, syncStatus: "error", syncError: error, updatedAt: new Date().toISOString() });
  }

  async markProviderCalDavAccountSyncOk(providerId: string): Promise<void> {
    const existing = this.caldavAccounts.get(providerId);
    if (!existing || existing.syncStatus === "disconnected") return;
    this.caldavAccounts.set(providerId, { ...existing, syncStatus: "connected", syncError: null, updatedAt: new Date().toISOString() });
  }

  // ============================================================================
  // Fase 6 §3 — dispatcher de correo (channel='email' de messaging_outbox)
  // ============================================================================

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const claimable = [...this.outbox.values()]
      .filter((o) => o.channel === "email" && (o.status === "pending" || o.status === "failed") && o.attempts < 5)
      .slice(0, Math.max(limit, 0));
    for (const job of claimable) {
      job.status = "processing";
      job.attempts += 1;
    }
    return claimable.map((job) => ({ id: job.id, organizationId: job.organizationId, attempts: job.attempts, payload: (job.payload ?? {}) as Record<string, unknown> }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    const job = this.outbox.get(id);
    if (!job || job.channel !== "email") return;
    job.status = status;
    job.lastError = error === null ? null : error.slice(0, 500);
  }

  // ---- FASE 3 (producto) -- bitácora de auditoría del staff ----

  async registrarAuditoria(input: RegistrarCitasAuditoriaInput): Promise<void> {
    // A diferencia de PostgresCitasRepository (que ignora `input.actorUserId` y
    // deja que `citas.record_audit_log` capture el actor real vía `auth.uid()`),
    // este doble en memoria SÍ lo usa -- no hay sesión SQL/`auth.uid()` que
    // simular aquí, y los tests necesitan un actor real para poder afirmar
    // "quién" quedó registrado.
    this.auditLogSeq += 1;
    this.auditLog.push({
      id: randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      // Trunca a los MISMOS límites que el CHECK de `citas.audit_log`
      // (200/500/500, ver migrations/023_citas_audit_log.sql) -- mismo criterio
      // que `left(..., N)` dentro de `citas.record_audit_log`.
      campo: truncarCampoAuditoriaCitas(input.campo, AUDIT_LOG_CAMPO_MAX),
      antes: truncarCampoAuditoriaCitas(input.antes, AUDIT_LOG_TEXTO_MAX),
      despues: truncarCampoAuditoriaCitas(input.despues, AUDIT_LOG_TEXTO_MAX),
      createdAtMs: Date.now(),
      seq: this.auditLogSeq,
    });
  }

  async listAuditoria(organizationId: string, filtro: CitasAuditLogFiltro, paginacion: CitasAuditLogPaginacion): Promise<CitasAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    let filtrados = this.auditLog.filter((r) => r.organizationId === organizationId);
    if (filtro.entityType) filtrados = filtrados.filter((r) => r.entityType === filtro.entityType);
    // Mismo criterio EXACTO que `PostgresCitasRepository.listAuditoria` -- ancla
    // `desde`/`hasta` a America/Mexico_City (offset fijo `-06:00`) para que
    // ambos repositorios (real e in-memory) clasifiquen el mismo instante en el
    // mismo día de filtro.
    if (filtro.desde) {
      const desdeMs = new Date(`${filtro.desde}T00:00:00-06:00`).getTime();
      filtrados = filtrados.filter((r) => r.createdAtMs >= desdeMs);
    }
    if (filtro.hasta) {
      const hastaExclusivoMs = new Date(`${filtro.hasta}T00:00:00-06:00`).getTime() + 24 * 60 * 60 * 1000;
      filtrados = filtrados.filter((r) => r.createdAtMs < hastaExclusivoMs);
    }
    // Desempate por `seq` cuando `createdAtMs` empata (dos escrituras dentro del
    // mismo milisegundo) -- MISMO orden que `PostgresCitasRepository.
    // listAuditoria` (`order by created_at desc, seq desc`). `Array.prototype.sort`
    // es estable; sin este desempate dos filas empatadas quedarían en orden de
    // inserción (más antigua primero) en vez de "más reciente primero".
    filtrados = [...filtrados].sort((a, b) => b.createdAtMs - a.createdAtMs || b.seq - a.seq);

    const total = filtrados.length;
    const pagina = filtrados.slice(offset, offset + limit).map(({ organizationId: _organizationId, seq: _seq, ...row }) => row);
    return { disponible: true, items: pagina, total, nextOffset: offset + pagina.length < total ? offset + pagina.length : null };
  }
}
