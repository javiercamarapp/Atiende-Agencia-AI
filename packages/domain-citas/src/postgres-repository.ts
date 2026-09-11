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
import type {
  AppointmentActorChannel,
  AppointmentRecord,
  AvailabilityOverride,
  AvailabilityRule,
  BusyInterval,
  CustomerRecord,
  ProviderRecord,
  ServiceRecord,
} from "./types.ts";
import type { CancelResult, CitasRepository, CreateAppointmentResult, NewAppointmentInput, RescheduleResult, ReminderCandidateRow, WaitlistCandidateRow } from "./repository.ts";

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
  };
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

  async findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null> {
    const { rows } = await this.db.query<ServiceRow>(
      `select id, organization_id, name, duration_minutes, buffer_minutes_before, buffer_minutes_after, price_cents, is_active from citas.services where id = $1 and organization_id = $2;`,
      [serviceId, organizationId],
    );
    return rows[0] ? mapService(rows[0]) : null;
  }

  async providerOffersService(providerId: string, serviceId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ count: string }>(`select count(*)::text as count from citas.provider_services where provider_id = $1 and service_id = $2;`, [providerId, serviceId]);
    return Number(rows[0]?.count ?? "0") > 0;
  }

  async loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]> {
    const { rows } = await this.db.query<{ id: string; provider_id: string; day_of_week: number; start_time: string; end_time: string; is_active: boolean }>(
      `select id, provider_id, day_of_week, start_time, end_time, is_active from citas.availability_rules where provider_id = $1;`,
      [providerId],
    );
    return rows.map((r) => ({ id: r.id, providerId: r.provider_id, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time, isActive: r.is_active }));
  }

  async loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null> {
    const { rows } = await this.db.query<{ provider_id: string; override_date: string; is_closed: boolean; start_time: string | null; end_time: string | null }>(
      `select provider_id, override_date, is_closed, start_time, end_time from citas.availability_overrides where provider_id = $1 and override_date = $2;`,
      [providerId, dateStr],
    );
    const row = rows[0];
    return row ? { providerId: row.provider_id, overrideDate: row.override_date, isClosed: row.is_closed, startTime: row.start_time, endTime: row.end_time } : null;
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

  async upsertCustomer(organizationId: string, phone: string, name: string, email?: string | null): Promise<CustomerRecord> {
    const { rows: existingRows } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
      `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and phone = $2;`,
      [organizationId, phone],
    );
    if (existingRows[0]) {
      const existing = existingRows[0];
      if (!email) return { id: existing.id, organizationId: existing.organization_id, fullName: existing.full_name, phone: existing.phone, email: existing.email };
      const { rows: updated } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `update citas.customers set email = coalesce(email, $3), updated_at = now() where id = $1 and organization_id = $2 returning id, organization_id, full_name, phone, email;`,
        [existing.id, organizationId, email],
      );
      const row = updated[0] ?? existing;
      return { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email };
    }
    try {
      const { rows: created } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `insert into citas.customers (organization_id, phone, full_name, email) values ($1, $2, $3, $4) returning id, organization_id, full_name, phone, email;`,
        [organizationId, phone, name, email ?? null],
      );
      const row = created[0]!;
      return { id: row.id, organizationId: row.organization_id, fullName: row.full_name, phone: row.phone, email: row.email };
    } catch (err) {
      // Carrera real entre dos requests casi simultáneas del mismo cliente nuevo: el
      // UNIQUE(organization_id, phone) rechaza el segundo INSERT — se recupera en
      // vez de propagar un error genérico (mismo patrón que domain-restaurantes).
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      const { rows: race } = await this.db.query<{ id: string; organization_id: string; full_name: string; phone: string; email: string | null }>(
        `select id, organization_id, full_name, phone, email from citas.customers where organization_id = $1 and phone = $2;`,
        [organizationId, phone],
      );
      const winner = race[0];
      if (!winner) throw err;
      return { id: winner.id, organizationId: winner.organization_id, fullName: winner.full_name, phone: winner.phone, email: winner.email };
    }
  }

  async createAppointmentIdempotent(input: NewAppointmentInput, dedupeFingerprint: string, idempotencyKey: string | null): Promise<CreateAppointmentResult> {
    try {
      const { rows } = await this.db.query<{ create_appointment_idempotent: AppointmentRow }>(`select citas.create_appointment_idempotent($1::jsonb, $2, $3) as create_appointment_idempotent;`, [
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
      ]);
      return { outcome: "created", appointment: mapAppointment(rows[0]!.create_appointment_idempotent) };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT423") return { outcome: "conflict_slot_taken" };
      if (code === "AT409") return { outcome: "conflict_idempotency_reused" };
      throw err;
    }
  }

  async findAppointmentForOrganization(organizationId: string, appointmentId: string): Promise<AppointmentRecord | null> {
    const { rows } = await this.db.query<AppointmentRow>(
      `select id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, notes, dedupe_fingerprint, idempotency_key, reminder_24h_sent_at, created_at
       from citas.appointments where id = $1 and organization_id = $2;`,
      [appointmentId, organizationId],
    );
    return rows[0] ? mapAppointment(rows[0]) : null;
  }

  private async runCancelRpc(fn: "cancel_appointment_idempotent" | "cancel_appointment_from_panel", organizationId: string, appointmentId: string): Promise<CancelResult> {
    try {
      const { rows } = await this.db.query<{ [key: string]: AppointmentRow }>(`select citas.${fn}($1, $2) as result;`, [organizationId, appointmentId]);
      const appointment = mapAppointment((rows[0] as unknown as { result: AppointmentRow }).result);
      return { outcome: appointment.status === "cancelled" ? "cancelled" : "already_cancelled", appointment };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT404") return { outcome: "not_found" };
      if (code === "AT409") return { outcome: "conflict_invalid_status", status: "completed" };
      throw err;
    }
  }

  async cancelAppointmentIdempotent(organizationId: string, appointmentId: string): Promise<CancelResult> {
    return this.runCancelRpc("cancel_appointment_idempotent", organizationId, appointmentId);
  }

  async cancelAppointmentFromPanel(organizationId: string, appointmentId: string, _actorUserId: string): Promise<CancelResult> {
    return this.runCancelRpc("cancel_appointment_from_panel", organizationId, appointmentId);
  }

  async rescheduleAppointmentIdempotent(organizationId: string, appointmentId: string, newStartsAt: string, newEndsAt: string, actorChannel: AppointmentActorChannel, actorNote: string | null): Promise<RescheduleResult> {
    try {
      const { rows } = await this.db.query<{ reschedule_appointment_idempotent: AppointmentRow }>(`select citas.reschedule_appointment_idempotent($1, $2, $3, $4, $5, $6) as reschedule_appointment_idempotent;`, [
        organizationId,
        appointmentId,
        newStartsAt,
        newEndsAt,
        actorChannel,
        actorNote,
      ]);
      return { outcome: "rescheduled", appointment: mapAppointment(rows[0]!.reschedule_appointment_idempotent) };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
      if (code === "AT423") return { outcome: "conflict_slot_taken" };
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
    const { rows } = await this.db.query<{ appointment_id: string; provider_id: string; starts_at: string; customer_name: string | null; customer_phone: string }>(
      `select a.id as appointment_id, a.provider_id, a.starts_at, c.full_name as customer_name, c.phone as customer_phone
       from citas.appointments a
       join citas.customers c on c.id = a.customer_id
       where a.organization_id = $1 and a.status in ('pending','confirmed')
         and a.reminder_24h_sent_at is null
         and a.starts_at >= $2 and a.starts_at <= $3;`,
      [organizationId, windowStartIso, windowEndIso],
    );
    return rows.map((r) => ({ appointmentId: r.appointment_id, providerId: r.provider_id, startsAt: r.starts_at, customerName: r.customer_name, customerPhone: r.customer_phone }));
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
      `select id, customer_phone, customer_name, notified_count, provider_id, service_id, preferred_date_from, preferred_date_to, preferred_time_window, created_at
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

  async claimWaitlistNotificationSlot(waitlistId: string, maxNotifications: number): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string | null }>(`select (citas.claim_waitlist_notification_slot($1, $2)).id as id;`, [waitlistId, maxNotifications]);
    return rows[0]?.id != null;
  }

  async consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const { rows } = await this.db.query<{ consume_api_rate_limit: boolean }>(`select citas.consume_api_rate_limit($1, $2, $3, $4) as consume_api_rate_limit;`, [scope, actorHash, maxRequests, windowSeconds]);
    return rows[0]?.consume_api_rate_limit === true;
  }
}
