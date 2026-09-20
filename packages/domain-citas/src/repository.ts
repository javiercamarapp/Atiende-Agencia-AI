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
import type {
  AppointmentActorChannel,
  AppointmentRecord,
  AppointmentSource,
  AvailabilityOverride,
  AvailabilityOverrideInput,
  AvailabilityRule,
  AvailabilityRulePatch,
  BusyInterval,
  CitasAuditLogFiltro,
  CitasAuditLogPagina,
  CitasAuditLogPaginacion,
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

/** `forbidden_out_of_scope` — Fase 12 (hallazgo de auditoría ALTO, ver
 * errors.ts::AppointmentForbiddenError): el staff SÍ pertenece a la organización
 * pero su membership no cubre la sucursal de ESTA cita en particular. Presente en
 * los 4 resultados `*FromPanel` de abajo (cancel/confirm/complete/no-show) —
 * nunca en los del agente (cancelAppointmentIdempotent/rescheduleAppointmentIdempotent),
 * que corren con `userId: null` (sesión de sistema, sin `auth.uid()` de staff que
 * escopar). */
export type CancelResult =
  | { readonly outcome: "cancelled" | "already_cancelled"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

export type RescheduleResult =
  | { readonly outcome: "rescheduled" | "noop_same_slot"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "conflict_slot_taken" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string };

/** Fase 7 -- transición de estado confirmar/completar/no-show desde el panel de
 * staff. Mismo shape discriminado que CancelResult -- misma nota de diseño de
 * arriba aplica igual aquí (conflictos como valores, nunca excepciones desde el
 * repositorio). */
export type ConfirmResult =
  | { readonly outcome: "confirmed" | "already_confirmed"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

export type CompleteResult =
  | { readonly outcome: "completed" | "already_completed"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

export type NoShowResult =
  | { readonly outcome: "marked_no_show" | "already_no_show"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: string }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

/** Fase 6 §2 (seguimiento) — "reintentar sincronización" desde el panel: solo
 * tiene sentido sobre una cita que el motor YA marcó `google_sync_status =
 * 'invalid'` (rechazo permanente de validación, ver `GoogleSyncStatus`) —
 * cualquier otro estado es `conflict_invalid_status` (una cita `pending` ya se va
 * a reintentar sola; una `synced`/`skipped`/`error`/`deleted` no tiene nada que
 * reintentar aquí). Regresa la cita a `pending`/attempts=0 para que el próximo
 * best-effort (disparado por el caller HTTP justo después, mismo patrón que
 * crear/cancelar/reagendar) la recoja de inmediato con los datos ya corregidos. */
export type RetryCalendarSyncResult =
  | { readonly outcome: "retried"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "conflict_invalid_status"; readonly status: GoogleSyncStatus }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

/** Fase 6 §2 (seguimiento) — resumen de sincronizaciones con problema de UN
 * proveedor, para la advertencia ámbar de "Calendarios conectados" (nunca marca
 * la cuenta entera en rojo por esto — ver diseño en calendar-sync.ts: un rechazo
 * de validación de UNA cita no dice nada sobre si la credencial sirve). `count` =
 * número de citas de este proveedor actualmente en `google_sync_status =
 * 'invalid'` (se autolimpia solo: en cuanto el staff corrige el dato y reintenta,
 * la cita sale de 'invalid' y deja de contar) — `lastReason` es el motivo
 * normalizado y saneado (ver `sanitizeProviderSyncReason`) de la más reciente. */
export interface CalendarSyncIssuesSummary {
  readonly count: number;
  readonly lastReason: string | null;
}

/** Fase 12 (hallazgo de auditoría ALTO, "Staff no puede crear citas manualmente
 * desde la Agenda"): alta real de una cita desde el panel — `citas.
 * create_appointment_from_panel` (migrations/015). A diferencia de
 * `createAppointmentIdempotent` (agente, dedupe/idempotency-key de dos niveles),
 * esta es una acción DELIBERADA de un humano con un solo clic — sin dedupe, mismo
 * criterio que "confirmar"/"completar" del panel (también sin dedupe). El único
 * invariante real que nunca se salta es el EXCLUDE using gist (dos citas del mismo
 * proveedor no pueden traslaparse) -- `conflict_slot_taken` lo reporta. */
export type CreateFromPanelResult =
  | { readonly outcome: "created"; readonly appointment: AppointmentRecord }
  | { readonly outcome: "conflict_slot_taken" }
  | { readonly outcome: "forbidden_out_of_scope"; readonly message?: string };

export interface NewAppointmentFromPanelInput {
  readonly organizationId: string;
  /** Ya resuelto por el caller desde `provider.propertyId` (puede ser `null` — un
   * proveedor sin sucursal asignada, caso común de negocio de una sola ubicación,
   * ver diseño Fase 1 §1). */
  readonly propertyId: string | null;
  readonly providerId: string;
  readonly serviceId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerEmail: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly notes: string | null;
}

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
  /** Fase 6 §2 (seguimiento) — correo OPCIONAL del cliente (`citas.customers.email`,
   * columna que ya existía desde Fase 1 — nunca se le mandaba al motor de
   * sincronización). Cuando viene, `syncOneAppointmentRow` lo manda como
   * `attendeeEmail` al puerto genérico (Cal.com/CalDAV lo usan de verdad; Google lo
   * descarta a propósito, ver `GoogleCalendarSyncAdapter`) — cuando es `null` y
   * Cal.com rechaza el booking por eso, el motor lo clasifica como rechazo
   * permanente de validación con un motivo específico, nunca lo reintenta a
   * ciegas. */
  readonly customerEmail: string | null;
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

/** Fila de `citas.messaging_outbox` reclamada para despacho real — ver
 * migrations/007_messaging_outbox_dispatch.sql y
 * @atiende/whatsapp-gateway::MessagingOutboxPort (el puerto que
 * `createCitasMessagingOutboxPort` en whatsapp/outbox-adapter.ts implementa sobre
 * estos 4 métodos). */
export interface MessagingOutboxRow {
  readonly id: string;
  readonly attempts: number;
  readonly payload: unknown;
}

/** Fase 5 — panel de administración visual (ver README de esta fase). Página
 * paginada de resultados: `nextOffset` es `null` cuando ya no hay más filas. */
export interface CustomerPage {
  readonly items: readonly CustomerRecord[];
  readonly total: number;
  readonly nextOffset: number | null;
}

// ============================================================================
// Fase 6 §1 — guardia de crisis (ver diseño: vertical-config.ts + crisis-guardrail.ts).
// ============================================================================

/** `citas.tenant_config` (001_citas_schema.sql) — el rubro real (qué FAQs/guardrail
 * de crisis aplican), el timezone por defecto de la organización (usado por
 * `findPropertyTimezone` cuando la cita/proveedor no tiene sucursal con timezone
 * propio) y el teléfono de aviso urgente al dueño, si lo configuró.
 * `defaultTimezone` se agregó en Fase 8 junto con `upsertTenantConfig` — antes de
 * esa fase `findTenantConfig` (usado solo por el guardrail de crisis) no lo
 * necesitaba, pero el panel de Configuración sí edita el mismo campo que ya lee
 * `findPropertyTimezone` directo de la fila (ver postgres-repository.ts). */
export interface TenantConfigRecord {
  readonly organizationId: string;
  readonly rubro: string;
  readonly defaultTimezone: string;
  readonly ownerNotificationPhone: string | null;
}

/** Fase 8 — panel admin: edición real de `citas.tenant_config` (port de
 * `ConfiguracionSection.tsx::guardar` del origen, acotado a los 3 campos que
 * domain-citas modela — ver diseño Fase 8 §3). Patch parcial: un campo ausente deja
 * el valor actual intacto; `ownerNotificationPhone: null` explícito sí lo quita.
 * A propósito NO incluye `name`/`slug`/`status` del negocio (esos son
 * `core.organization`, un recurso compartido por las 6 verticales que
 * domain-citas no posee — ninguna otra vertical de este monorepo escribe
 * `core.organization` tampoco; ver resumen de la fase). */
export interface TenantConfigPatch {
  readonly rubro?: string;
  readonly defaultTimezone?: string;
  readonly ownerNotificationPhone?: string | null;
}

export interface EmergencyEscalationInput {
  readonly organizationId: string;
  readonly customerPhone: string;
  readonly channel: "whatsapp" | "voice";
  readonly keywordMatched: string;
  readonly messageExcerpt: string;
}

export interface EmergencyEscalationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly customerPhone: string;
  readonly channel: "whatsapp" | "voice";
  readonly keywordMatched: string;
  readonly messageExcerpt: string;
  readonly createdAt: string;
}

// ============================================================================
// Fase 6 §2 — cuentas de sincronización de calendario alternativas a Google
// (Cal.com/CalDAV, ver calendar-sync-port.ts/calcom-port.ts/caldav-port.ts).
// ============================================================================

export type CalendarProviderSyncStatus = "disconnected" | "connected" | "error";

export interface ProviderCalComAccountRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly calcomEventTypeId: string;
  /** URL base de una instancia Cal.com self-hosted (sin `/v2` final — ver
   * calcom-port.ts::CalComPortConfig.baseUrl), o `null` para el SaaS oficial
   * (`https://api.cal.com/v2`, el default de `RealCalComPort`). Igual que
   * `calendar_collection_url` de CalDAV, pasa por la MISMA validación SSRF real
   * antes de guardarse (ver apps/api/.../citas/calendar-providers.ts) — nunca solo
   * un chequeo de string. */
  readonly baseUrl: string | null;
  readonly syncStatus: CalendarProviderSyncStatus;
  readonly syncError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectProviderCalComAccountInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly calcomEventTypeId: string;
  /** En texto plano SOLO en esta frontera — el adaptador de Postgres lo envuelve de
   * inmediato en Supabase Vault (misma función genérica que Fase 3), nunca queda en
   * una columna en claro. El adaptador en memoria (tests) lo guarda tal cual. */
  readonly apiKey: string;
  /** Ver `ProviderCalComAccountRecord.baseUrl` — `undefined`/`null` = SaaS oficial. */
  readonly baseUrl?: string | null;
}

export interface ProviderCalDavAccountRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly calendarCollectionUrl: string;
  readonly username: string;
  readonly syncStatus: CalendarProviderSyncStatus;
  readonly syncError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConnectProviderCalDavAccountInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly calendarCollectionUrl: string;
  readonly username: string;
  /** Contraseña específica de aplicación — nunca en claro más allá de esta
   * frontera, mismo criterio que ConnectProviderCalComAccountInput.apiKey. */
  readonly password: string;
}

// ============================================================================
// Fase 6 §3 — dispatcher de correo (motor de envío real vía Resend, ver
// email-dispatch.ts). Acotado a channel='email' de `citas.messaging_outbox` —
// nunca toca una fila channel='whatsapp' (ver migración 009).
// ============================================================================

export interface EmailOutboxJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

export interface CitasRepository {
  // ---- Resolución de organización/proveedor/servicio (usado por los 3 flujos) ----
  findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null>;
  /** Fase 5 §1 — resuelve las properties (sucursales de `core.property`) de una
   * organización de citas, mismo rol que `listBranchesForOrganization` de
   * domain-restaurantes: el panel de administración solo conoce el slug de la
   * organización tras el login, nunca un propertyId (las rutas de staff SÍ lo
   * necesitan, ver `requirePropertyMembership`). A diferencia de restaurantes, citas
   * no tiene una tabla `citas.branch_detail` (sucursal no es un concepto de negocio
   * de esta vertical, ver diseño Fase 1 §2) — se lee directo de `core.property`,
   * sin slug propio. */
  listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]>;
  /** Timezone efectivo: el de la property/sucursal si `propertyId` no es null y
   * tiene uno propio configurado; si no, el timezone por defecto de la organización
   * (ver diseño Fase 1 §2 — citas es la primera vertical donde esto es relevante
   * para el CÁLCULO de negocio, no solo cosmético). */
  findPropertyTimezone(propertyId: string | null, organizationId: string): Promise<string>;
  findProvider(organizationId: string, providerId: string): Promise<ProviderRecord | null>;
  /** Batch de `findProvider` -- hallazgo de auditoría (rubro 10, "performance y
   * escalabilidad", severidad MEDIA: "Agenda de citas con 1+P+S+C queries por
   * carga"). Una sola consulta agregada (`WHERE id = ANY($1)`) para TODOS los
   * proveedores distintos referenciados por una página de citas, en vez de un
   * `findProvider` por id -- ver apps/api/.../citas/admin.ts::enrichAppointments,
   * que ya NO resuelve proveedor/servicio/cliente uno por uno. */
  findProvidersByIds(organizationId: string, providerIds: readonly string[]): Promise<readonly ProviderRecord[]>;
  findService(organizationId: string, serviceId: string): Promise<ServiceRecord | null>;
  /** Batch de `findService` -- mismo hallazgo que `findProvidersByIds` de arriba. */
  findServicesByIds(organizationId: string, serviceIds: readonly string[]): Promise<readonly ServiceRecord[]>;
  providerOffersService(providerId: string, serviceId: string): Promise<boolean>;
  /** Fase 8 — panel admin: alta/edición real de proveedores/servicios (port de
   * ProveedoresSection.tsx/ServiciosSection.tsx/FichaProveedor.tsx del origen —
   * ver diseño Fase 8 §1/§2). `createProvider`/`createService` devuelven el
   * registro completo ya creado; `updateProvider`/`updateService` devuelven `null`
   * si `id` no existe o no pertenece a `organizationId` — NUNCA edita a ciegas un
   * id de otra organización, mismo criterio que `updateProduct` de
   * domain-restaurantes. `setProviderServiceOffering` es el equivalente real del
   * checkbox de `FichaProveedor.tsx::toggleServicio`: `offered:true` inserta la
   * fila de `citas.provider_services` (si no existía ya — idempotente), `false` la
   * quita; el caller (admin.ts) ya validó que `providerId`/`serviceId` pertenecen a
   * la organización vía `findProvider`/`findService` antes de llamar aquí, mismo
   * motivo por el que `providerOffersService` de arriba tampoco pide
   * `organizationId`. */
  createProvider(input: NewProviderInput): Promise<ProviderRecord>;
  updateProvider(organizationId: string, providerId: string, patch: ProviderPatch): Promise<ProviderRecord | null>;
  setProviderServiceOffering(providerId: string, serviceId: string, offered: boolean): Promise<void>;
  createService(input: NewServiceInput): Promise<ServiceRecord>;
  updateService(organizationId: string, serviceId: string, patch: ServicePatch): Promise<ServiceRecord | null>;
  loadAvailabilityRules(providerId: string): Promise<readonly AvailabilityRule[]>;
  loadAvailabilityOverride(providerId: string, dateStr: string): Promise<AvailabilityOverride | null>;
  /** Fase 10 — panel admin: lista TODAS las excepciones de un proveedor (vista de
   * calendario del panel), a diferencia de `loadAvailabilityOverride` (una fecha
   * puntual, el que usa el motor de disponibilidad en cada cálculo de slots).
   * `fromDateInclusive`, si viene, acota a excepciones cuyo `overrideDate >=` esa
   * fecha (el caller pasa "hoy" para no mostrar cierres ya pasados) — sin él,
   * devuelve todas. Orden ascendente por fecha. */
  listAvailabilityOverrides(providerId: string, fromDateInclusive?: string): Promise<readonly AvailabilityOverride[]>;
  loadBusyIntervals(providerId: string, dayStartUtc: string, dayEndUtc: string, excludeAppointmentId?: string): Promise<readonly BusyInterval[]>;
  /** Fase 10 — panel admin: alta real de una regla de disponibilidad recurrente
   * (ver diseño Fase 10 §1, port de la sección de horarios que Disponibilidad.tsx
   * no exponía — ver README). El caller (admin.ts) ya validó que
   * `input.providerId` pertenece a la organización vía `findProvider` antes de
   * llamar aquí, mismo criterio que `setProviderServiceOffering`. */
  createAvailabilityRule(input: NewAvailabilityRuleInput): Promise<AvailabilityRule>;
  /** `ruleId` debe pertenecer a `providerId` — devuelve `null` si no (mismo
   * criterio que `updateProvider`: nunca edita a ciegas la fila de otro
   * proveedor). */
  updateAvailabilityRule(providerId: string, ruleId: string, patch: AvailabilityRulePatch): Promise<AvailabilityRule | null>;
  /** `true` si `ruleId` existía y pertenecía a `providerId` (y se borró), `false`
   * si no existía o era de otro proveedor. */
  deleteAvailabilityRule(providerId: string, ruleId: string): Promise<boolean>;
  /** Fase 10 — alta/edición real de una excepción puntual (cierre o horario
   * especial de un día concreto). Upsert real sobre la unique
   * (provider_id, override_date) de 001_citas_schema.sql — una segunda llamada
   * para la misma fecha reemplaza la fila existente, mismo criterio que
   * `upsertTenantConfig`. */
  upsertAvailabilityOverride(input: AvailabilityOverrideInput): Promise<AvailabilityOverride>;
  /** `true` si existía una excepción para `overrideDate` (y se borró), `false` si
   * no había ninguna. */
  deleteAvailabilityOverride(providerId: string, overrideDate: string): Promise<boolean>;

  // ---- Clientes (Flujo 1) ----
  upsertCustomer(organizationId: string, phone: string, name: string, email?: string | null): Promise<CustomerRecord>;
  /** Fase 2 §1.4/§5 — memoria de cliente por teléfono (agente de voz/WhatsApp).
   * `phone` debe llegar ya normalizado (ver `normalizePhone`) — nunca null en
   * cero-match, se resuelve devolviendo `null` para que el caller decida el
   * contrato de silencio (ver `findAppointmentsForCustomerPhone`). */
  findCustomerByPhone(organizationId: string, phone: string): Promise<CustomerRecord | null>;
  /** Fase 5 §1 — ficha de cliente del panel (busca por id en vez de por teléfono,
   * que es lo único que ya resolvía `findCustomerByPhone`). */
  findCustomerById(organizationId: string, customerId: string): Promise<CustomerRecord | null>;
  /** Batch de `findCustomerById` -- mismo hallazgo de auditoría (rubro 10) que
   * `findProvidersByIds`/`findServicesByIds` de arriba. */
  findCustomersByIds(organizationId: string, customerIds: readonly string[]): Promise<readonly CustomerRecord[]>;
  /** Fase 5 §1 — listado paginado de clientes para el panel (lista + búsqueda por
   * nombre/teléfono). Solo lee filas que `upsertCustomer` ya escribió — ninguna
   * regla de negocio nueva, mismo criterio que `listActiveServices`/
   * `listActiveProviders` (Fase 2 §1.2/§1.3): "listar lo que el dominio ya
   * calcula", nunca decide nada nuevo sobre el cliente. */
  listCustomers(organizationId: string, opts: { readonly limit: number; readonly offset: number; readonly search?: string }): Promise<CustomerPage>;
  /** Fase 6 §2 (seguimiento) — captura/edición del correo OPCIONAL de un cliente
   * YA existente desde la ficha de Clientes del panel (`citas.customers.email`
   * existía desde Fase 1 — nunca era editable después de la primera reserva). NUNCA
   * lo hace obligatorio: `email: null` explícito lo quita, un formato inválido
   * lanza `AppointmentValidationError` en la capa de negocio (appointments.ts), no
   * aquí. `null` de retorno = el cliente no existe en esta organización. */
  updateCustomerEmailFromPanel(organizationId: string, customerId: string, email: string | null): Promise<CustomerRecord | null>;

  // ---- Flujo 1: crear cita ----
  createAppointmentIdempotent(input: NewAppointmentInput, dedupeFingerprint: string, idempotencyKey: string | null): Promise<CreateAppointmentResult>;
  /** Fase 12 -- alta real de una cita desde el panel de staff (ver
   * CreateFromPanelResult para el detalle completo del gap que cierra). */
  createAppointmentFromPanel(input: NewAppointmentFromPanelInput): Promise<CreateFromPanelResult>;

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
  /** Fase 5 §1 — agenda del panel (vista mes/semana): citas reales de la
   * organización cuyo `starts_at` cae en `[fromIso, toIso)`, opcionalmente filtradas
   * por proveedor. Puro listado/paginado de filas que `createAppointmentIdempotent`/
   * `cancelAppointmentFromPanel`/etc. ya escribieron — ninguna regla de negocio
   * nueva (ver nota de diseño Fase 5 §0: "exponer/paginar lo que el dominio ya
   * calcula", nunca decidir algo nuevo sobre la cita). `limit` acota el peor caso
   * (una organización con un volumen anómalo de citas en el rango pedido) sin
   * cursor — un rango de fechas ya acota naturalmente el tamaño esperado. */
  listAppointmentsInRange(organizationId: string, fromIso: string, toIso: string, providerId: string | undefined, limit: number): Promise<readonly AppointmentRecord[]>;
  cancelAppointmentIdempotent(organizationId: string, appointmentId: string): Promise<CancelResult>;
  cancelAppointmentFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<CancelResult>;
  /** Fase 7 -- confirmar/completar/marcar no-show desde el panel de staff (única
   * fuente real hoy -- ver appointments-lifecycle.ts). `pending -> confirmed`,
   * idempotente si ya estaba confirmed, conflicto si ya es un estado terminal
   * (completed/cancelled/no_show). */
  confirmAppointmentFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<ConfirmResult>;
  /** `pending|confirmed -> completed`, idempotente si ya estaba completed,
   * conflicto si ya es cancelled/no_show. */
  completeAppointmentFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<CompleteResult>;
  /** `pending|confirmed -> no_show`, idempotente si ya estaba no_show, conflicto
   * si ya es completed/cancelled. A diferencia de 'completed', 'no_show' libera de
   * inmediato el horario del proveedor (fuera del EXCLUDE using gist de
   * 001_citas_schema.sql). */
  markAppointmentNoShowFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<NoShowResult>;
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
  /** Hallazgo CRÍTICO de auditoría (a1, r3) — `syncPendingAppointmentsMultiProvider`
   * procesa un LOTE de citas de varios tenants en UNA sola transacción (ver
   * `apps/api/.../citas/google-calendar-sync.ts`). Sin aislar cada fila, una fila
   * "venenosa" (cualquier error no capturado por `syncOneAppointmentRow`, ej. si su
   * propio `markAppointmentGoogleSyncInvalid` fallara con un código que el fallback
   * de arriba no reconoce) deja ABORTADA la transacción del LOTE completo — todas
   * las marcas `synced`/`deleted` de las filas YA procesadas en esta misma corrida
   * se revierten en silencio (mismo mecanismo que el fix de `markAppointmentGoogleSync
   * Invalid`), mientras que los eventos externos de esas filas YA se crearon en
   * Google/Cal.com/CalDAV — al no ser idempotente `createEvent`, la siguiente corrida
   * los duplica. Postgres real: correr `fn` protegido por un SAVEPOINT propio deja el
   * resto del lote intacto ante CUALQUIER error de una fila — implementación real en
   * `PostgresCitasRepository` (vía `runWithSavepointFallback`, `@atiende/db`); no-op
   * en `InMemoryCitasRepository` (sin transacción real que aislar). */
  runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T>;
  markAppointmentGoogleSynced(appointmentId: string, googleEventId: string, attempts: number): Promise<void>;
  markAppointmentGoogleSyncDeleted(appointmentId: string, attempts: number): Promise<void>;
  markAppointmentGoogleSyncSkipped(appointmentId: string): Promise<void>;
  markAppointmentGoogleSyncRetry(appointmentId: string, attempts: number, error: string, nextRetryAtIso: string): Promise<void>;
  markAppointmentGoogleSyncExhausted(appointmentId: string, attempts: number, error: string): Promise<void>;
  /** Fase 6 §2 (seguimiento) — rechazo PERMANENTE de validación (ver
   * `GoogleSyncStatus.invalid`): a diferencia de `markAppointmentGoogleSyncExhausted`
   * (backoff agotado, un reintento SÍ podía haber funcionado), esto nunca va a
   * funcionar solo — dispara de inmediato sin esperar `MAX_SYNC_ATTEMPTS`, igual
   * que `markAppointmentGoogleSyncExhausted` hace con `invalid_grant`. `reason` ya
   * viene saneado/truncado por el caller (`sanitizeProviderSyncReason`, nunca el
   * cuerpo crudo de la respuesta del proveedor). Nunca toca la cuenta del
   * proveedor -- la credencial sigue sirviendo, ver diseño de la cabecera de
   * calendar-sync.ts. */
  markAppointmentGoogleSyncInvalid(appointmentId: string, attempts: number, reason: string): Promise<void>;
  /** Fase 6 §2 (seguimiento) — botón "reintentar sincronización" del panel: solo
   * transiciona una cita que está en `google_sync_status = 'invalid'` de vuelta a
   * `pending`/attempts=0 (ver `RetryCalendarSyncResult`); cualquier otro estado es
   * `conflict_invalid_status`. Property-scoped igual que confirmar/completar/
   * no-show (`forbidden_out_of_scope` si el staff no cubre la sucursal de esta
   * cita). */
  retryAppointmentCalendarSyncFromPanel(organizationId: string, appointmentId: string, actorUserId: string): Promise<RetryCalendarSyncResult>;
  /** Fase 6 §2 (seguimiento) — resumen de sincronizaciones con problema de un
   * proveedor para la advertencia ámbar de "Calendarios conectados" (ver
   * `CalendarSyncIssuesSummary`): cuenta las citas de ESTE proveedor actualmente
   * en `google_sync_status = 'invalid'`, sin importar qué plataforma (Google/
   * Cal.com/CalDAV) tenga conectada -- un proveedor normalmente solo conecta una,
   * ver calendar-sync-resolver-factory.ts. */
  loadProviderCalendarSyncIssues(providerId: string): Promise<CalendarSyncIssuesSummary>;

  // ---- Flujo 3: recordatorio/confirmación ----
  listActiveOrganizations(): Promise<readonly { id: string; timezone: string }[]>;
  loadAppointmentsPendingReminder(organizationId: string, windowStartIso: string, windowEndIso: string): Promise<readonly ReminderCandidateRow[]>;
  markReminderSent(appointmentId: string, sentAtIso: string): Promise<void>;
  resolveActiveWhatsAppPhoneNumberId(organizationId: string): Promise<string | null>;
  enqueueMessagingOutbox(organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  // ---- Dispatcher real de messaging_outbox (migrations/007) — ver
  // whatsapp/outbox-adapter.ts para el adaptador que expone estos 4 métodos como
  // @atiende/whatsapp-gateway::MessagingOutboxPort. ----
  claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]>;
  markMessagingOutboxSent(id: string): Promise<void>;
  markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;
  markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void>;
  loadLiveWaitlistCandidates(organizationId: string): Promise<readonly WaitlistCandidateRow[]>;
  /** f2-citas-lista-de-espera — igual que `loadLiveWaitlistCandidates`, pero para
   * sesión de SISTEMA (`auth.uid()` null): `citas.appointment_waitlist` solo tiene
   * policy de RLS de staff (membership), así que el SELECT plano de
   * `loadLiveWaitlistCandidates` SIEMPRE devuelve 0 filas bajo sesión de sistema
   * (ver migración 020_appointment_waitlist_sistema_lectura.sql). Todos los
   * callers reales de este método (runOptimizadorCore -- cancelar/reagendar/
   * reasignar del agente, SIEMPRE sesión de sistema; runListaEsperaCore --
   * broadcast del staff, movido a sesión de sistema post-commit) corren en
   * sesión de sistema; el GET de solo-lectura del panel (`admin.ts`) sigue
   * usando `loadLiveWaitlistCandidates` (staff, RLS real). Compatibilidad con
   * la base sin migrar: implementación Postgres degrada a `[]` (SQLSTATE
   * 42883), nunca un 500. */
  loadLiveWaitlistCandidatesAsSystem(organizationId: string): Promise<readonly WaitlistCandidateRow[]>;
  /** Corrección post-revisión de f2-citas-lista-de-espera — igual que
   * `loadLiveWaitlistCandidatesAsSystem`, pero para el paso INMEDIATO siguiente
   * (resolver a qué `phone_number_id` mandar el aviso): `citas.whatsapp_config`
   * también solo tiene policy de RLS de staff (membership), así que
   * `resolveActiveWhatsAppPhoneNumberId` (SELECT plano) SIEMPRE devuelve `null`
   * bajo sesión de sistema, incluso con la migración 020 ya aplicada -- ver
   * migración 021_whatsapp_config_sistema_lectura.sql. Mismos dos callers reales
   * que `loadLiveWaitlistCandidatesAsSystem` (runOptimizadorCore/
   * runListaEsperaCore, ambos sesión de sistema); `previewListaEspera` (staff,
   * vista previa de solo lectura) sigue usando `resolveActiveWhatsAppPhoneNumberId`.
   * Compatibilidad con la base sin migrar: implementación Postgres degrada a
   * `null` (SQLSTATE 42883), nunca un 500. */
  resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId: string): Promise<string | null>;
  /** Corrección bloqueante de la ronda 2 de revisión del PR #180 — probe de SOLO
   * CATÁLOGO (nunca ejecuta ninguna de las dos funciones, no requiere `EXECUTE`
   * ni ningún fallback nuevo) que corre en sesión de STAFF: le dice a
   * `previewListaEspera` si las migraciones 020/021 ya están aplicadas en ESTA
   * base, ANTES de calcular un conteo de candidatos que el post-commit en
   * sesión de sistema nunca podría notificar de verdad. Sin este probe, con la
   * base sin migrar (el estado REAL de producción en el instante en que este
   * PR se mergea — nadie aplica las migraciones al mergear, ver regla dura de
   * compatibilidad del repo) el panel mostraba "Aviso encolado para N
   * candidatos" y el post-commit degradaba a `[]`/`null` por SQLSTATE 42883 sin
   * encolar nada: un éxito falso permanente, en vez del 500 visible que da hoy
   * `main` para esa misma acción. Implementación Postgres:
   * `to_regprocedure('citas.system_load_live_waitlist_candidates(uuid)')` +
   * la misma comprobación para `system_resolve_active_whatsapp_phone_number_id`
   * — una consulta al catálogo, disponible para cualquier rol, que nunca lanza
   * si la función no existe (a diferencia de invocarla). */
  areSystemWaitlistFunctionsAvailable(): Promise<boolean>;
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
  /** f2-citas-whatsapp-config-sesion-sistema — mismo gap de RLS que
   * `resolveActiveWhatsAppPhoneNumberIdAsSystem`, en la dirección INVERSA:
   * el webhook entrante de WhatsApp (`apps/api/.../citas/whatsapp.ts`) abre
   * su PROPIA sesión de sistema (`deps.engine.withAppSession({ userId: null
   * }, ...)`, sin `authMiddleware`/JWT — Meta no manda ningún usuario
   * autenticado) y usa `resolveOrganizationByPhoneNumberId` (SELECT plano
   * contra `citas.whatsapp_config`, policy de RLS solo de staff) como PRIMERA
   * consulta de esa sesión, para rutear el mensaje entrante a la
   * organización dueña de ese `phone_number_id`. Bajo `auth.uid()` null esa
   * policy SIEMPRE deniega -- 0 filas, en silencio -- así que ESTE webhook
   * jamás resolvía ninguna organización: cada mensaje entrante de WhatsApp
   * de citas caía en la rama "número no configurado" (`apps/api/.../citas/
   * whatsapp.ts`, `ack silencioso, no reintento`) sin importar qué tan bien
   * configurado estuviera el negocio -- el gap inverso, documentado como
   * pendiente por la migración 021 (`021_whatsapp_config_sistema_lectura.sql`,
   * comentario de cabecera). Arreglo: función `security definer` de
   * SOLO-SISTEMA `citas.system_resolve_organization_by_whatsapp_phone_number_id`
   * (migración `022_whatsapp_config_organizacion_sistema_lectura.sql`), mismo
   * patrón EXACTO que `system_resolve_active_whatsapp_phone_number_id` (021)
   * -- guard `auth.uid() is null`, revoke de `public`/`anon`/`authenticated` +
   * grant execute a `authenticated`, devuelve únicamente `organization_id`.
   * Compatibilidad con la base sin migrar: implementación Postgres degrada a
   * `null` (SQLSTATE 42883) -- el MISMO "número no configurado" honesto de
   * hoy, nunca un 500. */
  resolveOrganizationByPhoneNumberIdAsSystem(phoneNumberId: string): Promise<string | null>;
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

  // ---- Fase 6 §1 — guardia de crisis ----
  findTenantConfig(organizationId: string): Promise<TenantConfigRecord | null>;
  insertEmergencyEscalation(input: EmergencyEscalationInput): Promise<EmergencyEscalationRecord>;
  /** Fase 8 — panel admin: edición real de `citas.tenant_config` (port de
   * ConfiguracionSection.tsx del origen, ver TenantConfigPatch). Upsert real (no
   * solo update): a diferencia de providers/services, una organización de citas
   * puede no tener fila en `tenant_config` todavía (la migración solo le pone
   * defaults a nivel columna, ningún flujo de aprovisionamiento en este repo
   * inserta la fila — ver diseño Fase 8 §3) — la primera vez que el dueño abre
   * Configuración y guarda, esta llamada CREA la fila con sus defaults reales
   * (rubro='otro', default_timezone='America/Mexico_City') más el patch pedido,
   * nunca falla con "not found". Devuelve la fila completa ya escrita. */
  upsertTenantConfig(organizationId: string, patch: TenantConfigPatch): Promise<TenantConfigRecord>;

  // ---- Fase 6 §2/§3 — nombre de la organización para plantillas de correo
  // (ver appointment-email-notifications.ts) ----
  findOrganizationById(organizationId: string): Promise<{ readonly id: string; readonly name: string } | null>;

  // ---- Fase 6 §2 — Cal.com/CalDAV por proveedor ----
  findProviderCalComAccount(providerId: string): Promise<ProviderCalComAccountRecord | null>;
  connectProviderCalComAccount(input: ConnectProviderCalComAccountInput): Promise<ProviderCalComAccountRecord>;
  disconnectProviderCalComAccount(providerId: string): Promise<void>;
  resolveProviderCalComApiKey(providerId: string): Promise<string | null>;
  /** Falla PERMANENTE de credencial (401/403 real de Cal.com) — mismo criterio que
   * `setProviderCalendarAccountSyncError` (Google/invalid_grant): marca la cuenta en
   * error de una vez, en vez de quemar reintentos de backoff contra una API key que
   * ya sabemos que no sirve. También la usa la ruta de prueba de conexión
   * (`POST .../calcom/test-connection`) cuando la comprobación en vivo falla. */
  setProviderCalComAccountSyncError(providerId: string, error: string): Promise<void>;
  /** Contrario de `setProviderCalComAccountSyncError`: una comprobación en vivo
   * (prueba de conexión, o una sincronización real que sí tuvo éxito) confirma que
   * la cuenta vuelve a estar sana — limpia `sync_error` y regresa `sync_status` a
   * `'connected'` SIN tocar la credencial guardada (a diferencia de
   * `connectProviderCalComAccount`, que sí la reemplaza). No-op si la cuenta no
   * existe o ya está `'disconnected'` (una comprobación en vivo nunca reconecta
   * sola una cuenta que el staff desconectó a propósito). */
  markProviderCalComAccountSyncOk(providerId: string): Promise<void>;
  findProviderCalDavAccount(providerId: string): Promise<ProviderCalDavAccountRecord | null>;
  connectProviderCalDavAccount(input: ConnectProviderCalDavAccountInput): Promise<ProviderCalDavAccountRecord>;
  disconnectProviderCalDavAccount(providerId: string): Promise<void>;
  resolveProviderCalDavPassword(providerId: string): Promise<string | null>;
  /** Ver `setProviderCalComAccountSyncError` — mismo criterio para CalDAV (401/403
   * real del servidor, o un `CalendarConflictError` persistente no aplica aquí:
   * esto es solo para fallas de credencial). */
  setProviderCalDavAccountSyncError(providerId: string, error: string): Promise<void>;
  /** Ver `markProviderCalComAccountSyncOk` — mismo criterio para CalDAV. */
  markProviderCalDavAccountSyncOk(providerId: string): Promise<void>;

  // ---- Fase 6 §3 — dispatcher de correo ----
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;

  // ---- FASE 3 (producto) — bitácora de auditoría del staff, ver
  // migrations/023_citas_audit_log.sql. Mismo contrato exacto que
  // `RestaurantesRepository.registrarAuditoria`/`listAuditoria`. ----
  /** Nunca lanza -- best-effort real (regla dura de esta fase): un error real de
   *  la bitácora nunca puede tumbar ni revertir la acción de negocio que ya se
   *  completó, ver `PostgresCitasRepository.registrarAuditoria`. */
  registrarAuditoria(input: RegistrarCitasAuditoriaInput): Promise<void>;

  /** `disponible: false` (nunca lanza) cuando `citas.audit_log`/
   *  `citas.record_audit_log` todavía no existen en esta base (SQLSTATE
   *  42883/42P01/42703, base sin migrar) -- ver
   *  `PostgresCitasRepository.registrarAuditoria`. */
  listAuditoria(organizationId: string, filtro: CitasAuditLogFiltro, paginacion: CitasAuditLogPaginacion): Promise<CitasAuditLogPagina>;
}
