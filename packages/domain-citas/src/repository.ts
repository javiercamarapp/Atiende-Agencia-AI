// Puerto de acceso a datos de domain-citas — mismo patrón dual de adaptador que
// domain-restaurantes/domain-hoteles: un puerto TS explícito, con un adaptador real
// en memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession). Ninguna función de negocio de appointments.ts/reminders.ts toca
// SQL directamente — todas pasan por aquí. Ver diseño Fase 1 §3.1.
//
// Los estados de conflicto (slot_taken, idempotency reusada, cita no encontrada,
// estado no editable) se devuelven como VALORES DISCRIMINADOS, no como excepciones
// desde el repositorio — las excepciones tipadas (AppointmentConflictError, etc.)
// las lanza la capa de negocio (appointments.ts), nunca el adaptador. Esto reproduce
// fielmente el mapeo real AT423->conflict / AT404->not_found / AT409->conflict del
// origen sin acoplar el puerto a códigos de error de Postgres.
import type { AppointmentActorChannel, AppointmentRecord, AppointmentSource, AvailabilityOverride, AvailabilityRule, BusyInterval, CustomerRecord, GoogleSyncStatus, ProviderCalendarAccountRecord, ProviderRecord, ServiceRecord } from "./types.ts";

export interface NewAppointmentInput {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly providerId: string;
  readonly serviceId: string;
  readonly customerId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: "pending";
  readonly source: AppointmentSource;
  readonly notes: string | null;
}

export type CreateAppointmentResult =
  | { readonly outcome: "created" | "existing"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "conflict_slot_taken" }
  | { readonly outcome: "conflict_idempotency_reused" };

export type CancelResult =
  | { readonly outcome: "cancelled" | "already_cancelled"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string };

export type RescheduleResult =
  | { readonly outcome: "rescheduled" | "noop_same_slot"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "conflict_slot_taken" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string };

/** Fase 4 -- "modificar-cita" (cambio de proveedor/servicio sin tocar el horario
 * de inicio). Mismo shape discriminado que RescheduleResult -- misma nota de
 * diseño de arriba aplica igual aquí. */
export type ReassignResult =
  | { readonly outcome: "reassigned" | "noop_same_assignment"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "conflict_slot_taken" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string };

export interface ReminderCandidateRow {
  readonly appointmentId: string;
  readonly providerId: string;
  readonly startsAt: string;
  readonly customerName: string | null;
  readonly customerPhone: string;
}

/** Mismo shape que `ConversationMessage` de domain-restaurantes/domain-hoteles —
 * SOLO texto (role/content), nunca tool_calls/resultados crudos (ver diseño Fase 2
 * §2.5: el historial persistido entre turnos es efímero-de-texto, reconstruido en
 * cada turno junto con el mensaje nuevo). */
export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

// ============================================================================
// Fase 3 — sincronización con Google Calendar (ver diseño §3/§5/§6). El puerto de
// acceso a datos NUNCA importa GoogleCalendarPort ni toca la API de Google — solo
// modela lo que calendar-sync.ts/google-calendar-factory.ts necesitan leer/escribir.
// ============================================================================

export interface ConnectProviderCalendarAccountInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly googleCalendarId: string;
  /** En texto plano SOLO en esta frontera — el adaptador de Postgres lo envuelve de
   * inmediato en el secreto de Supabase Vault (`set_provider_calendar_refresh_token`,
   * ver diseño §4) antes de que toque ninguna columna en claro; el adaptador en
   * memoria (tests) lo guarda tal cual, nunca hay Vault real que envolver ahí. */
  readonly refreshToken: string;
}

/** Fila pre-unida (cita + servicio + cliente + timezone efectivo) que
 * calendar-sync.ts necesita para construir el evento de Google — evita que el motor
 * de sincronización tenga que orquestar 3 lookups sueltos por cita, mismo criterio
 * que `ReminderCandidateRow`. */
export interface AppointmentSyncRow {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly serviceName: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly notes: string | null;
  readonly timeZone: string;
  readonly googleEventId: string | null;
  readonly googleSyncStatus: GoogleSyncStatus;
  readonly googleSyncAttempts: number;
}

export interface WaitlistCandidateRow {
  readonly id: string;
  readonly customerPhone: string;
  readonly customerName: string | null;
  readonly notifiedCount: number;
  readonly providerId: string | null;
  readonly serviceId: string | null;
  readonly preferredDateFrom: string | null;
  readonly preferredDateTo: string | null;
  readonly preferredTimeWindow: "morning" | "afternoon" | "evening" | "any";
  readonly createdAt: string;
}

export interface CitasRepository {
  // ---- Resolución de organización/proveedor/servicio (usado por los 3 flujos) ----
  findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null>;
  /** Timezone efectivo: el de la property/sucursal si `propertyId` no es null y
   * tiene uno propio configurado; si no, el timezone por defecto de la organización
   * (ver diseño Fase 1 §2 — citas es la primera vertical donde esto es relevante
   * para el CÁLCULO de negocio, no solo cosmético). */
  findPropertyTimezone(propertyId: string | null, organizationId: string): Promise<string>;
  findProvider(organizationId: string, providerId: string): Promise<ProviderRecord | null>;
  findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null>;
  providerOffersService(providerId: string, serviceId: string): Promise<boolean>;
  loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]>;
  loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null>;
  loadBusyIntervals(providerId: string, dayStartUtc: string, dayEndUtc: string, excludeAppointmentId?: string): Promise<readonly BusyInterval[]>;

  // ---- Clientes (Flujo 1) ----
  upsertCustomer(organizationId: string, phone: string, name: string, email?: string | null): Promise<CustomerRecord>;
  /** Fase 2 §1.4/§5 — memoria de cliente por teléfono (agente de voz/WhatsApp).
   * `phone` debe llegar ya normalizado (ver `normalizePhone`) — nunca null en
   * cero-match, se resuelve devolviendo `null` para que el caller decida el
   * contrato de silencio (ver `findAppointmentsForCustomerPhone`). */
  findCustomerByPhone(organizationId: string, phone: string): Promise<CustomerRecord | null>;

  // ---- Flujo 1: crear cita ----
  createAppointmentIdempotent(input: NewAppointmentInput, dedupeFingerprint: string, idempotencyKey: string | null): Promise<CreateAppointmentResult>;

  // ---- Fase 2 §1.2/§1.3 — catálogo real para los Server Tools de voz/WhatsApp
  // (listar_servicios/listar_proveedores) — nunca inventado por el LLM. ----
  listActiveServices(organizationId: string): Promise<readonly ServiceRecord[]>;
  /** Si `serviceId` viene, filtra por `providerOffersService` (ya existe la
   * relación en Fase 1 — solo faltaba el listado). */
  listActiveProviders(organizationId: string, serviceId?: string): Promise<readonly ProviderRecord[]>;
  /** Fase 2 §1.4 — citas activas/próximas (pending|confirmed, startsAt >= now) de
   * UN cliente ya resuelto por `findCustomerByPhone`, más antigua primero. Nunca
   * expone citas de otro cliente/organización (scoped por customerId+organizationId). */
  listActiveAppointmentsForCustomer(organizationId: string, customerId: string, nowIso: string): Promise<readonly AppointmentRecord[]>;

  // ---- Flujo 2: cancelar/reagendar ----
  findAppointmentForOrganization(organizationId: string, appointmentId: string): Promise<AppointmentRecord | null>;
  cancelAppointmentIdempotent(organizationId: string, appointmentId: string): Promise<CancelResult>;
  cancelAppointmentFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<CancelResult>;
  rescheduleAppointmentIdempotent(
    organizationId: string,
    appointmentId: string,
    newStartsAt: string,
    newEndsAt: string,
    actorChannel: AppointmentActorChannel,
    actorNote: string | null,
  ): Promise<RescheduleResult>;
  /** Fase 4 -- "modificar-cita": cambio de proveedor y/o servicio SIN tocar
   * startsAt. `newEndsAt` ya viene recalculado por el caller (appointments.ts)
   * desde la duración del servicio final -- el repositorio nunca decide
   * duraciones, solo persiste. */
  reassignAppointmentIdempotent(
    organizationId: string,
    appointmentId: string,
    newProviderId: string,
    newServiceId: string,
    newEndsAt: string,
    actorChannel: AppointmentActorChannel,
    actorNote: string | null,
  ): Promise<ReassignResult>;

  // ---- Fase 3 — sincronización con Google Calendar (ver diseño §3/§4/§5) ----
  findProviderCalendarAccount(providerId: string): Promise<ProviderCalendarAccountRecord | null>;
  /** Upsert real: primera conexión inserta, una reconexión posterior actualiza el
   * mismo refresh token y vuelve a poner `sync_status='connected'` (ver diseño §4
   * paso 3 — "solo entonces hace upsert... con sync_status='connected'"). */
  connectProviderCalendarAccount(input: ConnectProviderCalendarAccountInput): Promise<ProviderCalendarAccountRecord>;
  /** Google rotó el refresh_token (pasa ocasionalmente) — persistirlo de inmediato es
   * lo que evita que la siguiente corrida falle con un token ya revocado (ver diseño
   * §4 paso 5). */
  rotateProviderCalendarRefreshToken(providerId: string, refreshToken: string): Promise<void>;
  /** Lee el refresh token real (vía Supabase Vault en Postgres, ver diseño §4) — el
   * adaptador de Postgres trata "el RPC de Vault no existe todavía" exactamente
   * igual que "sin proveedor conectado": null, nunca una excepción (ver diseño §4/§9,
   * mismo criterio honesto que `resolveRefreshTokenFromVault` del origen). */
  resolveProviderCalendarRefreshToken(providerId: string): Promise<string | null>;
  /** Falla PERMANENTE (invalid_grant: el proveedor revocó el acceso) — marca la
   * cuenta como desconectada de una vez, en vez de quemar los reintentos de cada
   * cita contra un token que ya sabemos que no sirve (ver diseño §8, riesgo 2). */
  setProviderCalendarAccountSyncError(providerId: string, error: string): Promise<void>;

  loadAppointmentSyncRow(appointmentId: string): Promise<AppointmentSyncRow | null>;
  /** Citas con `google_sync_status in ('pending','pending_cancel')` cuyo
   * `google_sync_next_retry_at` ya se cumplió (o nunca se intentó: null se trata
   * como "elegible de inmediato", ver diseño §5/§8), más viejas primero — el mismo
   * subconjunto real que recorre `syncPendingAppointments`. */
  loadPendingGoogleSyncAppointments(limit: number, nowIso: string): Promise<readonly AppointmentSyncRow[]>;
  markAppointmentGoogleSynced(appointmentId: string, googleEventId: string, attempts: number): Promise<void>;
  markAppointmentGoogleSyncDeleted(appointmentId: string, attempts: number): Promise<void>;
  markAppointmentGoogleSyncSkipped(appointmentId: string): Promise<void>;
  markAppointmentGoogleSyncRetry(appointmentId: string, attempts: number, error: string, nextRetryAtIso: string): Promise<void>;
  markAppointmentGoogleSyncExhausted(appointmentId: string, attempts: number, error: string): Promise<void>;

  // ---- Flujo 3: recordatorio/confirmación ----
  listActiveOrganizations(): Promise<readonly { id: string; timezone: string }[]>;
  loadAppointmentsPendingReminder(organizationId: string, windowStartIso: string, windowEndIso: string): Promise<readonly ReminderCandidateRow[]>;
  markReminderSent(appointmentId: string, sentAtIso: string): Promise<void>;
  resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null>;
  enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  loadLiveWaitlistCandidates(organizationId: string): Promise<readonly WaitlistCandidateRow[]>;
  claimWaitlistNotificationSlot(waitlistId: string, maxNotifications: number): Promise<boolean>;

  // ---- Idempotencia/rate-limit (transversal) ----
  consumeRateLimit(scope: string, actorHash: string, maxRequests: number, windowSeconds: number): Promise<boolean>;

  // ---- Fase 2 §2.6 — plomería de WhatsApp. La serialización de mensajes
  // casi-simultáneos del mismo teléfono NO vive aquí (a diferencia de
  // domain-restaurantes/domain-hoteles, que tienen su propio lease bespoke):
  // se adoptó @atiende/core-conversation (`withConversationLock`) para esa parte
  // (ver diseño Fase 2 §2.6-b y whatsapp/inbound.ts) — este repositorio solo
  // resuelve el número de WhatsApp de la organización, el dedupe de mensaje
  // at-least-once y el historial de conversación persistido. ----
  resolveOrganizationByPhoneNumberId(phoneNumberId: string): Promise<string | null>;
  claimWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string): Promise<boolean>;
  appendWhatsAppUserMessageOnce(organizationId: string, phone: string, message: ConversationMessage): Promise<readonly ConversationMessage[]>;
  whatsappAppendTurn(
    organizationId: string,
    phone: string,
    newMessages: readonly ConversationMessage[],
    status: "active" | "completed" | "abandoned" | null,
    appointmentId: string | null,
    propertyId: string | null,
  ): Promise<readonly ConversationMessage[]>;
  finishWhatsAppMessage(organizationId: string, messageId: string, phoneHash: string, status: "processed" | "failed", errorClass: string | null): Promise<void>;
  markInboundEventFailed(organizationId: string, messageId: string, errorClass: string): Promise<void>;
}
