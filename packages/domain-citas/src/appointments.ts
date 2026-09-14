// Lógica de negocio compartida por crear-cita/cancelar-cita/reagendar-cita — port de
// citas-reservaciones/supabase/functions/_shared/appointments-core.ts sobre el
// puerto CitasRepository en vez de un cliente supabase-js crudo (mismo cambio de
// firma que restaurantes/hoteles ya aplicaron a su lógica equivalente). Un solo
// lugar para "qué es una cita válida" — ver diseño Fase 1 §3.2.
import { createHash } from "node:crypto";
import { computeAvailableSlots, isSlotWithinAvailability, zonedDateStr, zonedTimeToUtc } from "./availability.ts";
import { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "./errors.ts";
import type { CitasRepository } from "./repository.ts";
import type { AppointmentRecord, CancelAppointmentPayload, CreateAppointmentPayload, ProviderRecord, ReassignAppointmentPayload, RescheduleAppointmentPayload, ServiceRecord, Slot } from "./types.ts";

/**
 * Estados que cuentan como "el proveedor está ocupado" — debe ser EXACTAMENTE el
 * mismo conjunto que la cláusula WHERE del EXCLUDE USING gist en la migración
 * (`status in ('pending','confirmed','completed')`). Exportado para que ningún otro
 * archivo pueda divergir en silencio de lo que la base de datos en verdad bloquea.
 */
export const BUSY_APPOINTMENT_STATUSES = ["pending", "confirmed", "completed"] as const;

/** Solo una cita todavía "viva" (no cancelada, no completada, no no-show) puede
 * reagendarse — mismo conjunto que ya usa cancel_appointment_idempotent/
 * cancel_appointment_from_panel. */
const LIFECYCLE_EDITABLE_STATUSES = ["pending", "confirmed"] as const;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** El id de conversación que ElevenLabs inyecta en el body del Server Tool — nunca
 * algo que el LLM elige o copia. Mismo patrón/regex que domain-restaurantes. */
export function isValidVoiceConversationId(value: unknown): value is string {
  return typeof value === "string" && /^conv_[a-z0-9]{10,190}$/i.test(value);
}

// El mismo cliente real llega con el teléfono en formatos distintos según el canal
// (voz transcribe lo que oye, WhatsApp manda el wa_id, el panel deja que el staff
// teclee lo que sea) — normalizamos a los últimos 10 dígitos, mismo criterio que
// domain-restaurantes/src/phone.ts::normalizePhone.
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length >= 7) return digits.slice(-10);
  return phone.trim();
}

function invalidOptionalString(value: unknown, maxLength: number): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.length > maxLength);
}

/** "YYYY-MM-DD" real y estricto — nunca deja pasar un string arbitrario a
 * `zonedTimeToUtc` (Fase 2 §1.1/§4.3: `consultar_disponibilidad` es el único
 * endpoint nuevo que recibe una fecha suelta del agente, sin pasar por un
 * `Date.parse` de un ISO 8601 completo como el resto de los flujos). Rechaza
 * también fechas de calendario inválidas (ej. "2026-02-30") en vez de dejar que
 * `Date.UTC` las normalice en silencio a otro día. */
function isValidDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return asDate.getUTCFullYear() === year && asDate.getUTCMonth() === month - 1 && asDate.getUTCDate() === day;
}

// ============================================================================
// Resolución compartida de proveedor/servicio/timezone/disponibilidad
// ============================================================================

interface ResolvedProviderAndService {
  readonly provider: ProviderRecord;
  readonly service: ServiceRecord;
  readonly timeZone: string;
}

async function resolveProviderAndService(repo: CitasRepository, organizationId: string, providerId: string, serviceId: string): Promise<ResolvedProviderAndService> {
  const provider = await repo.findProvider(organizationId, providerId);
  if (!provider || !provider.isActive) {
    throw new AppointmentValidationError(`Proveedor '${providerId}' no encontrado o inactivo`);
  }
  const service = await repo.findService(organizationId, serviceId);
  if (!service || !service.isActive) {
    throw new AppointmentValidationError(`Servicio '${serviceId}' no encontrado o inactivo`);
  }
  const offersService = await repo.providerOffersService(providerId, serviceId);
  if (!offersService) {
    throw new AppointmentValidationError("Este proveedor no ofrece el servicio solicitado");
  }
  const timeZone = await repo.findPropertyTimezone(provider.propertyId, organizationId);
  return { provider, service, timeZone };
}

async function loadRulesAndOverride(repo: CitasRepository, providerId: string, dateStr: string) {
  const [rules, override] = await Promise.all([repo.loadAvailabilityRules(providerId), repo.loadAvailabilityOverride(providerId, dateStr)]);
  return { rules, override };
}

/** Ver la nota de loadBusyForDay en el origen: al recalcular alternativas para
 * REAGENDAR una cita ya existente, esa misma cita no debe contar como "ocupada"
 * contra sí misma — si no se excluye, una alternativa que caiga cerca de su propio
 * horario actual se vería falsamente bloqueada por su propia fila. */
async function loadBusyForDay(repo: CitasRepository, providerId: string, dateStr: string, timeZone: string, excludeAppointmentId?: string) {
  const dayStartUtc = zonedTimeToUtc(dateStr, "00:00", timeZone);
  const dayEndUtc = zonedTimeToUtc(addDaysToDateStr(dateStr, 1), "00:00", timeZone);
  return repo.loadBusyIntervals(providerId, dayStartUtc.toISOString(), dayEndUtc.toISOString(), excludeAppointmentId);
}

/**
 * Alternativas REALES para el mismo día que se intentó reagendar, calculadas con el
 * MISMO motor que disponibilidad — nunca una lista inventada por el LLM. Si ni
 * siquiera se puede calcular, se prefiere devolver una lista vacía a fingir
 * alternativas: el caller igual sabe que el horario pedido no sirvió.
 */
async function computeAlternativeSlots(
  repo: CitasRepository,
  organizationId: string,
  providerId: string,
  serviceId: string,
  referenceInstant: Date,
  timeZone: string,
  excludeAppointmentId: string,
): Promise<{ startsAt: string; endsAt: string }[]> {
  try {
    const service = await repo.findService(organizationId, serviceId);
    if (!service) return [];
    const dateStr = zonedDateStr(referenceInstant, timeZone);
    const { rules, override } = await loadRulesAndOverride(repo, providerId, dateStr);
    const busy = await loadBusyForDay(repo, providerId, dateStr, timeZone, excludeAppointmentId);
    return computeAvailableSlots({
      dateStr,
      timeZone,
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferMinutesBefore,
      bufferAfterMinutes: service.bufferMinutesAfter,
      rules,
      override,
      busy,
    });
  } catch (err) {
    console.error("computeAlternativeSlots: no se pudieron calcular alternativas reales", err);
    return [];
  }
}

// ============================================================================
// Fase 2 §1.1 — consultar_disponibilidad (Server Tool de voz + tool de WhatsApp)
// ============================================================================

export interface QueryAvailabilityInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly serviceId: string;
  /** "YYYY-MM-DD" en la hora local del negocio — validado estrictamente antes de
   * tocar zonedTimeToUtc (ver diseño Fase 2 §1.1/§4.3). */
  readonly dateStr: string;
  /** Inyectable solo para tests deterministas de "ya pasó". */
  readonly now?: Date;
}

/**
 * Reutiliza el motor ya construido en Fase 1 (`computeAvailableSlots`) y la
 * resolución ya construida (`resolveProviderAndService`/`loadRulesAndOverride`/
 * `loadBusyForDay`, privadas de este mismo archivo) — mismo patrón que
 * `quoteOrder` reutilizando `buildOrderQuoteFromProducts` en restaurantes sin
 * tocar una línea de esos helpers. `resolveProviderAndService` ya lanza
 * `AppointmentValidationError` si el proveedor no ofrece el servicio — se deja
 * propagar tal cual, mismo mapeo 400 que ya usan las rutas existentes.
 */
export async function queryAvailability(repo: CitasRepository, input: QueryAvailabilityInput): Promise<{ readonly slots: readonly Slot[] }> {
  if (typeof input.dateStr !== "string" || !isValidDateStr(input.dateStr)) {
    throw new AppointmentValidationError("date debe tener formato YYYY-MM-DD válido");
  }
  const { service, timeZone } = await resolveProviderAndService(repo, input.organizationId, input.providerId, input.serviceId);
  const { rules, override } = await loadRulesAndOverride(repo, input.providerId, input.dateStr);
  const busy = await loadBusyForDay(repo, input.providerId, input.dateStr, timeZone);

  const slots = computeAvailableSlots({
    dateStr: input.dateStr,
    timeZone,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferMinutesBefore,
    bufferAfterMinutes: service.bufferMinutesAfter,
    rules,
    override,
    busy,
    now: input.now,
  });
  return { slots };
}

// ============================================================================
// Flujo 1 — crear cita
// ============================================================================

export function validateCreateAppointmentPayload(raw: CreateAppointmentPayload): CreateAppointmentPayload {
  if (!raw || typeof raw !== "object") {
    throw new AppointmentValidationError("Payload inválido");
  }
  if (
    typeof raw.organizationId !== "string" ||
    !raw.organizationId.trim() ||
    typeof raw.providerId !== "string" ||
    !raw.providerId.trim() ||
    typeof raw.serviceId !== "string" ||
    !raw.serviceId.trim() ||
    typeof raw.customerName !== "string" ||
    !raw.customerName.trim() ||
    typeof raw.customerPhone !== "string" ||
    !raw.customerPhone.trim() ||
    typeof raw.startsAt !== "string" ||
    Number.isNaN(Date.parse(raw.startsAt))
  ) {
    throw new AppointmentValidationError("providerId, serviceId, customerName, customerPhone y startsAt (ISO 8601 válido) son requeridos");
  }
  if (
    raw.providerId.length > 64 ||
    raw.serviceId.length > 64 ||
    raw.customerName.trim().length > 160 ||
    raw.customerPhone.length > 64 ||
    invalidOptionalString(raw.propertyId, 64) ||
    invalidOptionalString(raw.customerEmail, 320) ||
    invalidOptionalString(raw.notes, 2000) ||
    invalidOptionalString(raw.conversationId, 200) ||
    invalidOptionalString(raw.idempotencyKey, 200)
  ) {
    throw new AppointmentValidationError("Uno o más campos exceden el tamaño permitido");
  }
  if (raw.source !== undefined && !["voice", "whatsapp", "web", "manual"].includes(raw.source)) {
    throw new AppointmentValidationError("source inválido");
  }
  return {
    ...raw,
    customerName: raw.customerName.trim(),
    customerPhone: normalizePhone(raw.customerPhone),
    customerEmail: raw.customerEmail?.trim() || undefined,
    notes: raw.notes?.trim() || undefined,
  };
}

export interface PreparedAppointment {
  readonly payload: CreateAppointmentPayload;
  readonly provider: ProviderRecord;
  readonly service: ServiceRecord;
  readonly timeZone: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Todo lo que crear-cita necesita antes de decidir si el horario es válido:
 * proveedor/servicio resueltos, timezone efectivo, y el slot exacto (startsAt/
 * endsAt) ya validado contra disponibilidad real — separado de `createAppointment`
 * para que un futuro endpoint de vista previa pueda reusar la validación sin
 * insertar nada.
 */
export async function prepareCreateAppointment(repo: CitasRepository, rawPayload: CreateAppointmentPayload): Promise<PreparedAppointment> {
  const payload = validateCreateAppointmentPayload(rawPayload);
  const { provider, service, timeZone } = await resolveProviderAndService(repo, payload.organizationId, payload.providerId, payload.serviceId);

  if (payload.propertyId && provider.propertyId && payload.propertyId !== provider.propertyId) {
    throw new AppointmentValidationError("propertyId no coincide con la sucursal del proveedor");
  }

  const startsAt = new Date(payload.startsAt);
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  const localDateStr = zonedDateStr(startsAt, timeZone);
  const { rules, override } = await loadRulesAndOverride(repo, payload.providerId, localDateStr);

  const withinAvailability = isSlotWithinAvailability(startsAt, endsAt, {
    timeZone,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferMinutesBefore,
    bufferAfterMinutes: service.bufferMinutesAfter,
    rules,
    override,
  });
  if (!withinAvailability) {
    throw new AppointmentConflictError(
      "El horario solicitado no está dentro de la disponibilidad real del proveedor. Vuelve a consultar disponibilidad y ofrece exactamente uno de esos horarios.",
    );
  }

  return { payload, provider, service, timeZone, startsAt, endsAt };
}

/**
 * Crea la cita de verdad: memoria de cliente (upsertCustomer) + inserción
 * idempotente de dos niveles (idempotencyKey explícito + dedupeFingerprint
 * automático) — nunca dos filas reales por una sola intención real de cita
 * (protección real y a prueba de canal, port literal de createAppointmentCore).
 */
export async function createAppointment(repo: CitasRepository, rawPayload: CreateAppointmentPayload): Promise<AppointmentRecord> {
  const { payload, provider, service, startsAt, endsAt } = await prepareCreateAppointment(repo, rawPayload);

  const customer = await repo.upsertCustomer(payload.organizationId, payload.customerPhone, payload.customerName, payload.customerEmail ?? null);

  const dedupeFingerprint = sha256Hex(
    JSON.stringify({
      organization_id: payload.organizationId,
      provider_id: provider.id,
      service_id: service.id,
      customer_id: customer.id,
      starts_at: startsAt.toISOString(),
      source: payload.source ?? "manual",
    }),
  );
  const idempotencyKey = payload.idempotencyKey ? sha256Hex(`${payload.organizationId}:${payload.idempotencyKey}`) : null;

  const result = await repo.createAppointmentIdempotent(
    {
      organizationId: payload.organizationId,
      propertyId: provider.propertyId,
      providerId: provider.id,
      serviceId: service.id,
      customerId: customer.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: "pending",
      source: payload.source ?? "manual",
      notes: payload.notes ?? null,
    },
    dedupeFingerprint,
    idempotencyKey,
  );

  if (result.outcome === "conflict_slot_taken") {
    throw new AppointmentConflictError("Ese horario ya no está disponible — alguien más lo tomó primero. Vuelve a consultar disponibilidad.");
  }
  if (result.outcome === "conflict_idempotency_reused") {
    throw new AppointmentConflictError("Este intento de cita ya fue procesado con datos diferentes. Revisa la cita existente antes de crear otra.");
  }
  return result.appointment;
}

// ============================================================================
// Flujo 2a — cancelar cita
// ============================================================================

export function validateCancelAppointmentPayload(raw: CancelAppointmentPayload): CancelAppointmentPayload {
  if (!raw || typeof raw !== "object" || typeof raw.organizationId !== "string" || !raw.organizationId.trim() || typeof raw.appointmentId !== "string" || !raw.appointmentId.trim() || raw.appointmentId.length > 64) {
    throw new AppointmentValidationError("appointmentId es requerido");
  }
  return { organizationId: raw.organizationId, appointmentId: raw.appointmentId.trim() };
}

function resolveCancelOutcome(result: { outcome: "cancelled" | "already_cancelled"; appointment: AppointmentRecord } | { outcome: "not_found" } | { outcome: "conflict_invalid_status"; status: string }): AppointmentRecord {
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede cancelar una cita en estado '${result.status}'.`);
  }
  return result.appointment;
}

/** Cancelar vía el agente (voz/WhatsApp) — equivalente a cancel_appointment_idempotent. */
export async function cancelAppointment(repo: CitasRepository, rawPayload: CancelAppointmentPayload): Promise<AppointmentRecord> {
  const payload = validateCancelAppointmentPayload(rawPayload);
  const result = await repo.cancelAppointmentIdempotent(payload.organizationId, payload.appointmentId);
  return resolveCancelOutcome(result);
}

/** Cancelar desde el panel de staff — equivalente a cancel_appointment_from_panel.
 * Sin distinción de rol (ver roles.ts): cualquier miembro del staff puede cancelar,
 * igual que el origen. */
export async function cancelAppointmentFromPanel(repo: CitasRepository, organizationId: string, appointmentId: string, actorUserId: string): Promise<AppointmentRecord> {
  const validated = validateCancelAppointmentPayload({ organizationId, appointmentId });
  const result = await repo.cancelAppointmentFromPanel(validated.organizationId, validated.appointmentId, actorUserId);
  return resolveCancelOutcome(result);
}

// ============================================================================
// Flujo 2c — transición de estado confirmar/completar/no-show desde el panel de
// staff (Fase 7). Gap real de auditoría: el repo original (citas-reservaciones/
// src/components/admin/AgendaSection.tsx, funciones confirmarCita/completarCita y
// un update directo a status:'no_show') permite estas 3 transiciones; esta rama
// preservaba los 5 estados en el esquema (001_citas_schema.sql) pero ninguna
// función de negocio los escribía — una cita nunca salía de 'pending'/'confirmed'
// aunque el cliente hubiera asistido. Mismo criterio EXACTO que
// cancelAppointmentFromPanel arriba: sin distinción de rol (roles.ts), valida
// appointmentId con el mismo validador que cancelar (ambos solo necesitan
// organizationId+appointmentId), y resuelve el resultado discriminado del
// repositorio a una excepción tipada o al registro actualizado.
// ============================================================================

function resolveConfirmOutcome(result: { outcome: "confirmed" | "already_confirmed"; appointment: AppointmentRecord } | { outcome: "not_found" } | { outcome: "conflict_invalid_status"; status: string }): AppointmentRecord {
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede confirmar una cita en estado '${result.status}'.`);
  }
  return result.appointment;
}

function resolveCompleteOutcome(result: { outcome: "completed" | "already_completed"; appointment: AppointmentRecord } | { outcome: "not_found" } | { outcome: "conflict_invalid_status"; status: string }): AppointmentRecord {
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede completar una cita en estado '${result.status}'.`);
  }
  return result.appointment;
}

function resolveNoShowOutcome(result: { outcome: "marked_no_show" | "already_no_show"; appointment: AppointmentRecord } | { outcome: "not_found" } | { outcome: "conflict_invalid_status"; status: string }): AppointmentRecord {
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede marcar como no-show una cita en estado '${result.status}'.`);
  }
  return result.appointment;
}

/** Confirmar desde el panel de staff — pending -> confirmed. */
export async function confirmAppointmentFromPanel(repo: CitasRepository, organizationId: string, appointmentId: string, actorUserId: string): Promise<AppointmentRecord> {
  const validated = validateCancelAppointmentPayload({ organizationId, appointmentId });
  const result = await repo.confirmAppointmentFromPanel(validated.organizationId, validated.appointmentId, actorUserId);
  return resolveConfirmOutcome(result);
}

/** Completar desde el panel de staff — pending|confirmed -> completed. */
export async function completeAppointmentFromPanel(repo: CitasRepository, organizationId: string, appointmentId: string, actorUserId: string): Promise<AppointmentRecord> {
  const validated = validateCancelAppointmentPayload({ organizationId, appointmentId });
  const result = await repo.completeAppointmentFromPanel(validated.organizationId, validated.appointmentId, actorUserId);
  return resolveCompleteOutcome(result);
}

/** Marcar no-show desde el panel de staff — pending|confirmed -> no_show. */
export async function markAppointmentNoShowFromPanel(repo: CitasRepository, organizationId: string, appointmentId: string, actorUserId: string): Promise<AppointmentRecord> {
  const validated = validateCancelAppointmentPayload({ organizationId, appointmentId });
  const result = await repo.markAppointmentNoShowFromPanel(validated.organizationId, validated.appointmentId, actorUserId);
  return resolveNoShowOutcome(result);
}

// ============================================================================
// Flujo 2b — reagendar cita (nunca cancela+recrea: conserva el mismo id, ver
// diseño Fase 1 §0.2/§5.2)
// ============================================================================

export function validateRescheduleAppointmentPayload(raw: RescheduleAppointmentPayload): RescheduleAppointmentPayload {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.organizationId !== "string" ||
    !raw.organizationId.trim() ||
    typeof raw.appointmentId !== "string" ||
    !raw.appointmentId.trim() ||
    raw.appointmentId.length > 64 ||
    typeof raw.newStartsAt !== "string" ||
    Number.isNaN(Date.parse(raw.newStartsAt)) ||
    invalidOptionalString(raw.actorNote, 2000)
  ) {
    throw new AppointmentValidationError("appointmentId y newStartsAt (ISO 8601 válido) son requeridos");
  }
  if (raw.actorChannel !== undefined && !["voice", "whatsapp", "web", "manual", "panel"].includes(raw.actorChannel)) {
    throw new AppointmentValidationError("actorChannel inválido");
  }
  return {
    ...raw,
    appointmentId: raw.appointmentId.trim(),
    actorNote: raw.actorNote?.trim() || undefined,
  };
}

export interface PreparedReschedule {
  readonly payload: RescheduleAppointmentPayload;
  readonly appointment: AppointmentRecord;
  readonly service: ServiceRecord;
  readonly timeZone: string;
  readonly newStartsAt: Date;
  readonly newEndsAt: Date;
}

/**
 * Validación completa ANTES de tocar la base de datos: carga la cita CON SCOPE a
 * organización (nunca confiar en un appointment_id adivinado de otra
 * organización), valida estado editable, recalcula endsAt desde la duración REAL
 * del servicio (nunca confía en un endsAt que mande el caller), y revalida el
 * horario nuevo contra la disponibilidad real del proveedor EXCLUYENDO la propia
 * cita de su cálculo de "ocupado" (si no se excluye, una cita no puede
 * "reagendarse" a un horario cercano al suyo propio porque se vería a sí misma
 * como conflicto).
 */
export async function prepareRescheduleAppointment(repo: CitasRepository, rawPayload: RescheduleAppointmentPayload): Promise<PreparedReschedule> {
  const payload = validateRescheduleAppointmentPayload(rawPayload);
  const appointment = await repo.findAppointmentForOrganization(payload.organizationId, payload.appointmentId);
  if (!appointment) throw new AppointmentNotFoundError("Cita no encontrada");

  if (!(LIFECYCLE_EDITABLE_STATUSES as readonly string[]).includes(appointment.status)) {
    throw new AppointmentConflictError(`No se puede reagendar una cita en estado '${appointment.status}'.`);
  }

  const { service, timeZone } = await resolveProviderAndService(repo, payload.organizationId, appointment.providerId, appointment.serviceId);

  const newStartsAt = new Date(payload.newStartsAt);
  const newEndsAt = new Date(newStartsAt.getTime() + service.durationMinutes * 60_000);

  // NOTA: isSlotWithinAvailability solo valida horario de ATENCIÓN (rules/override)
  // — nunca traslape con otras citas (busy). Esto es intencional y port literal del
  // origen: el traslape real lo decide el EXCLUDE USING gist de la base de datos
  // (autoridad final, capa 1 de anti-doble-reserva, ver diseño Fase 1 §0.7), que
  // reschedule_appointment_idempotent aplica al hacer el UPDATE — `busy` solo se
  // necesita para CALCULAR ALTERNATIVAS reales cuando el horario pedido no sirve
  // (ver computeAlternativeSlots más abajo), nunca para esta revalidación de
  // horario de atención.
  const localDateStr = zonedDateStr(newStartsAt, timeZone);
  const { rules, override } = await loadRulesAndOverride(repo, appointment.providerId, localDateStr);

  const withinAvailability = isSlotWithinAvailability(newStartsAt, newEndsAt, {
    timeZone,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferMinutesBefore,
    bufferAfterMinutes: service.bufferMinutesAfter,
    rules,
    override,
  });
  if (!withinAvailability) {
    const alternatives = await computeAlternativeSlots(repo, payload.organizationId, appointment.providerId, appointment.serviceId, newStartsAt, timeZone, appointment.id);
    throw new AppointmentAlternativesError(
      "El nuevo horario solicitado no está dentro de la disponibilidad real del proveedor. Vuelve a consultar disponibilidad y ofrece exactamente uno de esos horarios.",
      alternatives,
    );
  }

  return { payload, appointment, service, timeZone, newStartsAt, newEndsAt };
}

export interface RescheduleOutcome {
  readonly appointment: AppointmentRecord;
  /** El horario VIEJO de la cita, capturado antes del RPC — el hueco que en verdad
   * se libera (nunca el nuevo). Ver diseño Fase 1 §5.2. */
  readonly previousStartsAt: string;
}

export async function rescheduleAppointment(repo: CitasRepository, rawPayload: RescheduleAppointmentPayload): Promise<RescheduleOutcome> {
  const prepared = await prepareRescheduleAppointment(repo, rawPayload);
  const { payload, appointment, timeZone, newStartsAt, newEndsAt } = prepared;
  // Capturado ANTES del RPC a propósito: un adaptador en memoria puede mutar el
  // mismo objeto `appointment` in-place al aplicar el "UPDATE" — sin esta captura
  // temprana, `appointment.startsAt` leído después ya sería el horario NUEVO.
  const previousStartsAt = appointment.startsAt;

  const result = await repo.rescheduleAppointmentIdempotent(payload.organizationId, appointment.id, newStartsAt.toISOString(), newEndsAt.toISOString(), payload.actorChannel ?? "manual", payload.actorNote ?? null);

  if (result.outcome === "conflict_slot_taken") {
    // La revisión de horario de atención de arriba pasó, pero la base de datos —
    // la autoridad final anti-traslape — encontró que alguien más tomó ese hueco
    // justo antes que nosotros. Mismas alternativas reales, recalculadas ahora.
    const alternatives = await computeAlternativeSlots(repo, payload.organizationId, appointment.providerId, appointment.serviceId, newStartsAt, timeZone, appointment.id);
    throw new AppointmentAlternativesError("Ese horario ya no está disponible para este proveedor — alguien más lo tomó primero. Vuelve a consultar disponibilidad.", alternatives);
  }
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede reagendar una cita en estado '${result.status}'.`);
  }

  return { appointment: result.appointment, previousStartsAt };
}

// ============================================================================
// Fase 4 — "modificar-cita": cambio de proveedor y/o servicio de una cita
// existente SIN tocar el horario de inicio (startsAt se conserva; endsAt se
// recalcula desde la duración del servicio final). Explícitamente diferido
// desde Fase 1 (README de domain-citas), nunca construido en Fase 2/3. Mismo
// principio de "revalidar todo antes de tocar la base de datos" que
// prepareRescheduleAppointment, aplicado a proveedor/servicio en vez de horario.
// ============================================================================

export function validateReassignAppointmentPayload(raw: ReassignAppointmentPayload): ReassignAppointmentPayload {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.organizationId !== "string" ||
    !raw.organizationId.trim() ||
    typeof raw.appointmentId !== "string" ||
    !raw.appointmentId.trim() ||
    raw.appointmentId.length > 64 ||
    (raw.newProviderId === undefined && raw.newServiceId === undefined) ||
    (raw.newProviderId !== undefined && (typeof raw.newProviderId !== "string" || !raw.newProviderId.trim())) ||
    (raw.newServiceId !== undefined && (typeof raw.newServiceId !== "string" || !raw.newServiceId.trim())) ||
    invalidOptionalString(raw.actorNote, 2000)
  ) {
    throw new AppointmentValidationError("appointmentId y al menos uno de newProviderId/newServiceId son requeridos");
  }
  if (raw.actorChannel !== undefined && !["voice", "whatsapp", "web", "manual", "panel"].includes(raw.actorChannel)) {
    throw new AppointmentValidationError("actorChannel inválido");
  }
  return {
    ...raw,
    appointmentId: raw.appointmentId.trim(),
    actorNote: raw.actorNote?.trim() || undefined,
  };
}

export interface PreparedReassign {
  readonly payload: ReassignAppointmentPayload;
  readonly appointment: AppointmentRecord;
  readonly finalProviderId: string;
  readonly finalServiceId: string;
  readonly timeZone: string;
  readonly startsAt: Date;
  readonly newEndsAt: Date;
}

/** Misma disciplina que prepareRescheduleAppointment: validación completa ANTES
 * de tocar la base de datos. `newProviderId`/`newServiceId` ausentes se resuelven
 * al valor ACTUAL de la cita — permite cambiar solo uno de los dos sin tener que
 * repetir el otro. */
export async function prepareReassignAppointment(repo: CitasRepository, rawPayload: ReassignAppointmentPayload): Promise<PreparedReassign> {
  const payload = validateReassignAppointmentPayload(rawPayload);
  const appointment = await repo.findAppointmentForOrganization(payload.organizationId, payload.appointmentId);
  if (!appointment) throw new AppointmentNotFoundError("Cita no encontrada");

  if (!(LIFECYCLE_EDITABLE_STATUSES as readonly string[]).includes(appointment.status)) {
    throw new AppointmentConflictError(`No se puede modificar una cita en estado '${appointment.status}'.`);
  }

  const finalProviderId = payload.newProviderId ?? appointment.providerId;
  const finalServiceId = payload.newServiceId ?? appointment.serviceId;
  if (finalProviderId === appointment.providerId && finalServiceId === appointment.serviceId) {
    throw new AppointmentValidationError("newProviderId/newServiceId coinciden con la asignación actual — no hay ningún cambio que aplicar.");
  }

  // resolveProviderAndService valida provider/service activos Y que el proveedor
  // FINAL ofrezca el servicio FINAL (providerOffersService) — nunca asume que la
  // combinación pedida es válida solo porque cada id existe por separado.
  const { service, timeZone } = await resolveProviderAndService(repo, payload.organizationId, finalProviderId, finalServiceId);

  const startsAt = new Date(appointment.startsAt);
  const newEndsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  const localDateStr = zonedDateStr(startsAt, timeZone);
  const { rules, override } = await loadRulesAndOverride(repo, finalProviderId, localDateStr);

  const withinAvailability = isSlotWithinAvailability(startsAt, newEndsAt, {
    timeZone,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferMinutesBefore,
    bufferAfterMinutes: service.bufferMinutesAfter,
    rules,
    override,
  });
  if (!withinAvailability) {
    const alternatives = await computeAlternativeSlots(repo, payload.organizationId, finalProviderId, finalServiceId, startsAt, timeZone, appointment.id);
    throw new AppointmentAlternativesError(
      "El proveedor/servicio solicitado no tiene disponibilidad real a la hora actual de la cita. Elige uno de estos horarios o conserva el proveedor/servicio original.",
      alternatives,
    );
  }

  return { payload, appointment, finalProviderId, finalServiceId, timeZone, startsAt, newEndsAt };
}

export interface ReassignOutcome {
  readonly appointment: AppointmentRecord;
  /** Proveedor/servicio VIEJOS, capturados antes del RPC — el hueco (provider,
   * service, startsAt) que en verdad se libera cuando el cambio es real. Mismo
   * criterio que RescheduleOutcome.previousStartsAt. */
  readonly previousProviderId: string;
  readonly previousServiceId: string;
}

export async function reassignAppointment(repo: CitasRepository, rawPayload: ReassignAppointmentPayload): Promise<ReassignOutcome> {
  const prepared = await prepareReassignAppointment(repo, rawPayload);
  const { payload, appointment, finalProviderId, finalServiceId, timeZone, startsAt, newEndsAt } = prepared;
  // Capturado ANTES del RPC a propósito — mismo motivo que rescheduleAppointment:
  // un adaptador en memoria puede mutar el mismo objeto `appointment` in-place.
  const previousProviderId = appointment.providerId;
  const previousServiceId = appointment.serviceId;

  const result = await repo.reassignAppointmentIdempotent(payload.organizationId, appointment.id, finalProviderId, finalServiceId, newEndsAt.toISOString(), payload.actorChannel ?? "manual", payload.actorNote ?? null);

  if (result.outcome === "conflict_slot_taken") {
    // Misma razón que rescheduleAppointment: la revisión de horario de atención
    // de arriba pasó, pero el EXCLUDE USING gist real (autoridad final anti-
    // traslape) encontró que el proveedor final ya tiene otra cita en ese hueco.
    const alternatives = await computeAlternativeSlots(repo, payload.organizationId, finalProviderId, finalServiceId, startsAt, timeZone, appointment.id);
    throw new AppointmentAlternativesError("Ese proveedor ya tiene otra cita en ese horario — alguien más lo tomó primero.", alternatives);
  }
  if (result.outcome === "not_found") throw new AppointmentNotFoundError("Cita no encontrada");
  if (result.outcome === "conflict_invalid_status") {
    throw new AppointmentConflictError(`No se puede modificar una cita en estado '${result.status}'.`);
  }

  return { appointment: result.appointment, previousProviderId, previousServiceId };
}

// ============================================================================
// Fase 2 §1.4 — buscar_citas_cliente (Server Tool de voz, mayor riesgo real) +
// buscar_mis_citas (tool de WhatsApp). Misma función de dominio respalda ambos
// canales — ver diseño Fase 2 §2.4 ("un solo núcleo, dos canales").
// ============================================================================

export interface CustomerAppointmentSummary {
  readonly appointmentId: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: AppointmentRecord["status"];
}

/**
 * Contrato de SILENCIO ante cero-match (mismo criterio que restaurantes): un
 * teléfono nunca visto en esta organización devuelve `{ appointments: [] }`,
 * nunca un error — un mensaje hostil pidiendo "las citas de otro número" no
 * tiene ningún campo que pueda usar para suplantar a otro cliente, porque
 * `phone` SIEMPRE llega inyectado server-side (canal de voz: variable dinámica
 * de plataforma de ElevenLabs; WhatsApp: remitente real del webhook — ver
 * diseño Fase 2 §1.4/§4.4), nunca como parámetro que el LLM redacta. Solo
 * citas activas/próximas (pending|confirmed, startsAt >= now) — nunca el
 * historial completo de citas pasadas/canceladas de un cliente.
 */
export async function findAppointmentsForCustomerPhone(
  repo: CitasRepository,
  organizationId: string,
  phone: string,
  now: Date = new Date(),
): Promise<{ readonly appointments: readonly CustomerAppointmentSummary[] }> {
  const normalized = normalizePhone(phone);
  const customer = await repo.findCustomerByPhone(organizationId, normalized);
  if (!customer) return { appointments: [] };

  const rows = await repo.listActiveAppointmentsForCustomer(organizationId, customer.id, now.toISOString());
  return {
    appointments: rows.map((a) => ({ appointmentId: a.id, providerId: a.providerId, serviceId: a.serviceId, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status })),
  };
}
