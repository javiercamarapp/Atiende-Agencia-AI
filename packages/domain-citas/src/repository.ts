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
  CustomerRecord,
  GoogleSyncStatus,
  NewAvailabilityRuleInput,
  NewProviderInput,
  NewServiceInput,
  ProviderCalendarAccountRecord,
  ProviderPatch,
  ProviderRecord,
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
  // ---- Dispatcher real de messaging_outbox (migrations/007) — ver
  // whatsapp/outbox-adapter.ts para el adaptador que expone estos 4 métodos como
  // @atiende/whatsapp-gateway::MessagingOutboxPort. ----
  claimMessagingOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxRow[]>;
  markMessagingOutboxSent(id: string): Promise<void>;
  markMessagingOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;
  markMessagingOutboxDead(id: string, attempts: number, errorClass: string): Promise<void>;
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
  findProviderCalDavAccount(providerId: string): Promise<ProviderCalDavAccountRecord | null>;
  connectProviderCalDavAccount(input: ConnectProviderCalDavAccountInput): Promise<ProviderCalDavAccountRecord>;
  disconnectProviderCalDavAccount(providerId: string): Promise<void>;
  resolveProviderCalDavPassword(providerId: string): Promise<string | null>;

  // ---- Fase 6 §3 — dispatcher de correo ----
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;
}
