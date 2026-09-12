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
  AvailabilityRule,
  BusyInterval,
  CustomerRecord,
  GoogleSyncStatus,
  ProviderCalendarAccountRecord,
  ProviderRecord,
  ServiceRecord,
} from "./types.ts";
import type {
  AppointmentSyncRow,
  CancelResult,
  CitasRepository,
  ConnectProviderCalendarAccountInput,
  ConversationMessage,
  CreateAppointmentResult,
  CustomerPage,
  MessagingOutboxRow,
  NewAppointmentInput,
  ReassignResult,
  RescheduleResult,
  ReminderCandidateRow,
  WaitlistCandidateRow,
} from "./repository.ts";

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

  seedWaitlistEntry(row: Omit<StoredWaitlistRow, "id" | "status" | "notifiedCount" | "createdAt" | "expiresAt"> & { id?: string; expiresAt?: string }): string {
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
      createdAt: new Date().toISOString(),
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

  getOutbox(): readonly { organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: unknown; status: string; attempts: number }[] {
    return [...this.outbox.values()];
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
    return this.organizations.get(organizationId)?.defaultTimezone ?? "America/Mexico_City";
  }

  async findProvider(organizationId: string, providerId: string): Promise<ProviderRecord | null> {
    const provider = this.providers.get(providerId);
    if (!provider || provider.organizationId !== organizationId) return null;
    return provider;
  }

  async findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null> {
    const service = this.services.get(serviceId);
    if (!service || service.organizationId !== organizationId) return null;
    return service;
  }

  async providerOffersService(providerId: string, serviceId: string): Promise<boolean> {
    return this.providerServices.has(`${providerId}:${serviceId}`);
  }

  async loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]> {
    return this.availabilityRules.get(providerId) ?? [];
  }

  async loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null> {
    return this.availabilityOverrides.get(`${providerId}:${dateStr}`) ?? null;
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
    this.outbox.set(id, { id, organizationId, channel, eventType, dedupeKey, payload, status: "pending", attempts: 0, claimedAt: null, nextAttemptAt: 0, lastErrorClass: null });
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
}
