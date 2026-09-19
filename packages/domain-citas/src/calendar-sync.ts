// Motor de sincronización de calendario — port de
// citas-reservaciones/supabase/functions/_shared/calendar-sync-core.ts
// (`syncPendingAppointments`/`trySyncAppointmentNow`) sobre `CitasRepository` en vez
// de un cliente supabase-js crudo. Ver diseño Fase 3 §5/§6/§8, generalizado en
// Fase 6 §2 (seguimiento) para despachar por proveedor (Google/Cal.com/CalDAV) a
// través del contrato genérico `CalendarSyncPort` (calendar-sync-port.ts) en vez de
// estar acoplado al `GoogleCalendarPort` concreto.
//
// Principio que gobierna TODO este archivo, igual que el origen: "el software es la
// fuente de verdad. El calendario externo es downstream: se sincroniza después de
// que el INSERT/UPDATE en la base de datos fue exitoso." Nada aquí escribe
// `status`/`starts_at`/`ends_at` de una cita — solo lee esas columnas (ya
// congeladas por create/cancel/reschedule_appointment_idempotent) y escribe el
// resultado de sincronizarlas hacia el calendario externo en `google_sync_*`
// (nombre de columna heredado de Fase 3, reutilizado tal cual para las tres
// plataformas — ver diseño de esta fase: renombrar esas columnas es un cambio de
// esquema sin valor funcional nuevo, `AppointmentSyncRow`/`repository.ts` ya
// documentan que son el rastreo genérico "evento en el calendario externo que sea",
// no algo exclusivo de Google).
//
// DISEÑO de esta generalización — por qué el motor de Google (`tryTriggerGoogleSync`/
// `syncPendingAppointments`/`ResolveCalendarPort`, todos Fase 3, YA MERGEADOS Y
// PROBADOS) sigue exportado con la MISMA firma pública exacta: sus pruebas
// (`tests/calendar-sync.spec.ts`) pasan un `FakeGoogleCalendarPort` crudo (forma
// `{calendarId, ...}`, sin `platform`/`listAvailability`) directo como valor de
// retorno del resolver — cambiar esa firma habría roto esas pruebas sin ganar nada,
// porque el contrato genérico exige `externalCalendarRef`/`platform` que
// `GoogleCalendarPort` no modela. En vez de dos motores paralelos (duplicando toda
// la lógica de backoff/reintentos/exhausted), `syncOneAppointmentRow` de abajo es
// UN SOLO motor genérico sobre `CalendarSyncPort`; `syncPendingAppointments`/
// `tryTriggerGoogleSync` (Google-específicos) son wrappers delgados que envuelven el
// `GoogleCalendarPort` resuelto en un `GoogleCalendarSyncAdapter` (calendar-sync-
// port.ts, ya existente desde esta misma fase) ANTES de delegar en el motor
// genérico — mismo comportamiento observable, cero lógica duplicada. Producción
// (apps/api) usa las versiones genéricas nuevas (`tryTriggerCalendarSync`/
// `syncPendingAppointmentsMultiProvider`) con un resolver que cubre las tres
// plataformas (ver calendar-sync-resolver-factory.ts).
import { CalendarEventNotFoundError, GoogleCalendarApiError, isInvalidGrantError } from "./google-calendar-port.ts";
import type { GoogleCalendarPort } from "./google-calendar-port.ts";
import { CalComApiError } from "./calcom-port.ts";
import { CalDavApiError } from "./caldav-port.ts";
import { GoogleCalendarSyncAdapter } from "./calendar-sync-port.ts";
import type { CalendarPlatform, CalendarSyncPort } from "./calendar-sync-port.ts";
import type { AppointmentSyncRow, CitasRepository } from "./repository.ts";

/**
 * Resuelve el GoogleCalendarPort a usar para UN proveedor concreto (cada proveedor
 * tiene su propio refresh token OAuth), o `null` cuando ese proveedor no tiene forma
 * de sincronizar todavía (sin conectar, credenciales de plataforma pendientes, o
 * cuenta marcada en error) — el caller lo trata igual que "sin calendario
 * conectado": skip, nunca un error a reintentar. Producción:
 * `createGoogleCalendarPortResolver` (google-calendar-factory.ts); pruebas: un
 * resolver fijo sobre un `FakeGoogleCalendarPort` (ver google-calendar-port.ts).
 *
 * SOLO Google — ver `ResolveCalendarSyncPort` de abajo para el resolver genérico
 * multi-proveedor que usa producción hoy.
 */
export type ResolveCalendarPort = (providerId: string) => Promise<GoogleCalendarPort | null>;

/** Un puerto genérico ya resuelto, junto con la referencia de calendario externo
 * (`externalCalendarRef`, ver calendar-sync-port.ts para su significado por
 * plataforma: calendarId de Google / eventTypeId de Cal.com / colección CalDAV) que
 * ese proveedor tiene configurada — el motor genérico nunca vuelve a resolver esa
 * referencia por su cuenta, la recibe ya resuelta junto con el puerto (evita una
 * segunda consulta a la tabla de cuentas que el propio resolver ya consultó para
 * decidir qué plataforma está conectada). */
export interface ResolvedCalendarSync {
  readonly port: CalendarSyncPort;
  readonly externalCalendarRef: string;
}

/**
 * Resuelve, para UN proveedor, cuál de las tres plataformas (Google/Cal.com/CalDAV)
 * tiene conectada y devuelve su puerto genérico ya listo + su `externalCalendarRef`
 * — o `null` si ninguna está conectada (o las que hay están en error/sin
 * credenciales de plataforma). Producción: `createCalendarSyncPortResolver`
 * (calendar-sync-resolver-factory.ts); pruebas: un resolver fijo sobre
 * `FakeCalendarSyncPort` (calendar-sync-port.ts) o los simuladores HTTP reales
 * (tests/calcom-sim.ts, tests/caldav-sim.ts).
 */
export type ResolveCalendarSyncPort = (providerId: string) => Promise<ResolvedCalendarSync | null>;

export const MAX_SYNC_ATTEMPTS = 5;
export const SYNC_BATCH_SIZE = 100;

/** Backoff exponencial: 1, 2, 4, 8, 16 minutos — igual que el origen (ver diseño §8). */
export function nextSyncBackoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** attempt, 16 * 60_000);
}

export interface SyncSummary {
  processed: number;
  synced: number;
  retried: number;
  exhausted: number;
  /** Fase 6 §2 (seguimiento) — citas que el motor dejó de reintentar de inmediato
   * por un rechazo PERMANENTE de validación (`google_sync_status = 'invalid'`,
   * ver `isPermanentValidationError`) — distinto de `exhausted` (backoff agotado
   * tras `MAX_SYNC_ATTEMPTS` intentos que SÍ podían haber funcionado). */
  invalid: number;
  skipped: number;
  errors: { appointmentId: string; error: string }[];
}

function emptySummary(): SyncSummary {
  return { processed: 0, synced: 0, retried: 0, exhausted: 0, invalid: 0, skipped: 0, errors: [] };
}

function buildEventSummary(row: AppointmentSyncRow): string {
  return `${row.serviceName ?? "Cita"} - ${row.customerName ?? "Cliente"}`;
}

function buildEventDescription(row: AppointmentSyncRow): string {
  const lines = [`Tel: ${row.customerPhone ?? "N/D"}`, "Agendada por atiende.ai"];
  if (row.notes) lines.unshift(row.notes);
  return lines.join("\n");
}

/** Falla PERMANENTE de credencial (no reintentable) sea cual sea la plataforma:
 * Google `invalid_grant` (refresh token revocado), o un 401/403 HTTP real de
 * Cal.com/CalDAV (API key revocada / contraseña de aplicación revocada) — mismo
 * criterio de "esto no se va a arreglar solo con un reintento" en los tres casos. */
function isPermanentAuthError(err: unknown): boolean {
  if (isInvalidGrantError(err)) return true;
  if (err instanceof CalComApiError && (err.status === 401 || err.status === 403)) return true;
  if (err instanceof CalDavApiError && (err.status === 401 || err.status === 403)) return true;
  return false;
}

function permanentAuthErrorMessage(platform: CalendarPlatform): string {
  if (platform === "google") return "Google revocó el acceso (invalid_grant) — el proveedor debe reconectar su Google Calendar.";
  if (platform === "calcom") return "Cal.com rechazó la API key (401/403) — probablemente fue revocada. El proveedor debe reconectar Cal.com.";
  return "El servidor CalDAV rechazó las credenciales (401/403) — probablemente la contraseña de aplicación fue revocada. El proveedor debe reconectar CalDAV.";
}

/** Códigos HTTP que, para Google/Cal.com/CalDAV, significan "esta solicitud en
 * particular está mal formada o el proveedor la rechazó por una regla de negocio
 * suya (no una credencial inválida)" — nunca se va a arreglar solo reintentando
 * la MISMA cita con los MISMOS datos, a diferencia de un 5xx/timeout/429 (ver
 * `isPermanentValidationError` de abajo). 401/403 ya los intercepta
 * `isPermanentAuthError` ANTES de llegar aquí (mismo error, dos lecturas: sigue
 * siendo la credencial); 404 normalmente se intercepta antes como
 * `CalendarEventNotFoundError` en los tres adaptadores reales (ver
 * google-calendar-port.ts/calcom-port.ts/caldav-port.ts) — queda listado aquí
 * igual por si algún adaptador futuro no hace esa distinción, para que ese caso
 * tampoco se reintente 5 veces a ciegas. 409/412 de CalDAV (conflicto de ETag,
 * `CalendarConflictError`) NO están aquí a propósito: ese es un caso de
 * concurrencia optimista real (releer y reintentar SÍ puede funcionar), distinto
 * de una validación permanente. */
const VALIDATION_STATUS_CODES = new Set([400, 404, 409, 422]);

/** Fallo PERMANENTE de validación (4xx real del proveedor que no es de
 * credencial) — ver la nota de `VALIDATION_STATUS_CODES`. Se evalúa DESPUÉS de
 * `isPermanentAuthError` en el catch de `syncOneAppointmentRow`, así que un
 * 401/403 nunca llega aquí. */
function isPermanentValidationError(err: unknown, platform: CalendarPlatform): boolean {
  if (platform === "google" && err instanceof GoogleCalendarApiError) return VALIDATION_STATUS_CODES.has(err.status);
  if (platform === "calcom" && err instanceof CalComApiError) return VALIDATION_STATUS_CODES.has(err.status);
  if (platform === "caldav" && err instanceof CalDavApiError) return VALIDATION_STATUS_CODES.has(err.status);
  return false;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const MAX_SANITIZED_REASON_LEN = 300;

/** Nunca vuelca el cuerpo crudo de la respuesta de un proveedor (puede traer el
 * nombre/correo/teléfono del cliente que el propio proveedor rechazó) — sanea
 * (redacta lo que luce a correo/teléfono), colapsa espacios y trunca. Usado tanto
 * para el motivo que se guarda en la cita (`google_sync_error`) como para el que
 * ve el staff en el panel. */
export function sanitizeProviderSyncReason(raw: string, maxLen = MAX_SANITIZED_REASON_LEN): string {
  const redacted = raw.replace(EMAIL_RE, "[correo]").replace(PHONE_RE, "[teléfono]");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? `${collapsed.slice(0, maxLen)}…` : collapsed;
}

function providerLabel(platform: CalendarPlatform): string {
  if (platform === "google") return "Google Calendar";
  if (platform === "calcom") return "Cal.com";
  return "el servidor CalDAV";
}

/** Intenta sacar solo el MENSAJE semántico de un cuerpo JSON de error (p.ej.
 * `{"message": "..."}` o `{"error": {"message": "..."}}`, las dos formas reales
 * que usan los simuladores/adaptadores de este repo) en vez de devolver el
 * envelope JSON completo tal cual — un objeto anidado real (nombre/teléfono/
 * correo del cliente que el proveedor devolvió de vuelta, por ejemplo) nunca
 * debe reproducirse estructuralmente en `google_sync_error`. Cuerpo no-JSON (o
 * sin campo de mensaje reconocible): se devuelve tal cual, para que el caller lo
 * sanee como texto plano (nunca se pierde silenciosamente un diagnóstico real). */
function extractProviderMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.message === "string") return obj.message;
      const nestedError = obj.error;
      if (nestedError && typeof nestedError === "object" && typeof (nestedError as Record<string, unknown>).message === "string") {
        return (nestedError as Record<string, unknown>).message as string;
      }
    }
  } catch {
    // cuerpo no es JSON -- se trata como texto plano abajo.
  }
  return rawBody;
}

/** Motivo NORMALIZADO y legible en español para un rechazo permanente de
 * validación — nunca el cuerpo crudo de la respuesta (ver
 * `sanitizeProviderSyncReason`/`extractProviderMessage`). Caso especial
 * documentado por el diseño de esta fase: Cal.com puede exigir `attendeeEmail`
 * según cómo esté configurado el event type (ver calcom-port.ts) — cuando ESTA
 * cita no tiene correo de cliente guardado, es el motivo real más probable y el
 * más accionable de comunicar (dice exactamente qué falta y qué hacer), así que
 * se usa un mensaje curado en vez del texto del proveedor. Cualquier otro
 * rechazo de validación (Cal.com con correo ya presente, CalDAV, Google) cae al
 * mensaje genérico con el código HTTP real + el mensaje semántico extraído,
 * para no perder información real de depuración. */
function permanentValidationReason(err: unknown, platform: CalendarPlatform, row: AppointmentSyncRow): string {
  const isCreate = !row.googleEventId; // pending sin evento aún -> createEvent, no updateEvent.
  if (platform === "calcom" && isCreate && !row.customerEmail) {
    return "Cal.com exige el correo del cliente y esta cita no lo tiene. Agrega un correo al cliente desde su ficha en el panel y vuelve a intentar la sincronización.";
  }
  const label = providerLabel(platform);
  if (err instanceof CalComApiError || err instanceof CalDavApiError || err instanceof GoogleCalendarApiError) {
    const raw = err.body || err.message;
    const snippet = sanitizeProviderSyncReason(extractProviderMessage(raw));
    return `${label} rechazó esta cita (código ${err.status}): ${snippet}`;
  }
  const message = err instanceof Error ? err.message : "solicitud inválida";
  return `${label} rechazó esta cita: ${sanitizeProviderSyncReason(message)}`;
}

/** Marca la CUENTA (no la cita) en error permanente — dispatcha a la tabla correcta
 * según qué plataforma resolvió el puerto, mismo criterio de "evitar quemar
 * reintentos contra una credencial que ya sabemos que no sirve" en las tres. */
async function markAccountSyncError(repo: CitasRepository, platform: CalendarPlatform, providerId: string, message: string): Promise<void> {
  if (platform === "google") return repo.setProviderCalendarAccountSyncError(providerId, message);
  if (platform === "calcom") return repo.setProviderCalComAccountSyncError(providerId, message);
  return repo.setProviderCalDavAccountSyncError(providerId, message);
}

/**
 * Procesa UNA fila pendiente contra el puerto genérico ya resuelto. Nunca lanza por
 * un fallo del calendario externo — lo absorbe, calcula el próximo backoff (o marca
 * la cuenta desconectada de una vez si el error es una falla de credencial
 * permanente, ver diseño §8), y lo deja escrito en la fila para que la siguiente
 * corrida (o `tryTriggerCalendarSync`) lo reintente. Un fallo real de la base de
 * datos (leer/escribir la cita) sí se propaga — eso debe detener la corrida, nunca
 * absorberse en silencio.
 */
async function syncOneAppointmentRow(repo: CitasRepository, resolveSyncPort: ResolveCalendarSyncPort, row: AppointmentSyncRow, now: Date, summary: SyncSummary): Promise<void> {
  const resolved = await resolveSyncPort(row.providerId);
  if (!resolved) {
    // Sin calendario conectado (de NINGUNA plataforma), cuenta en error, o sin
    // credenciales de plataforma configuradas todavía — skip permanente, no es un
    // error a reintentar.
    await repo.markAppointmentGoogleSyncSkipped(row.id);
    summary.skipped += 1;
    return;
  }
  const { port: calendarPort, externalCalendarRef } = resolved;

  const attemptNum = row.googleSyncAttempts + 1;

  try {
    if (row.googleSyncStatus === "pending_cancel") {
      if (row.googleEventId) {
        try {
          await calendarPort.deleteEvent({ externalCalendarRef, eventId: row.googleEventId });
        } catch (err) {
          // Ya no existía en el calendario externo -> el estado deseado (que no
          // exista) ya se cumple; no es un fallo de sincronización (ver
          // calendar-sync-port.ts).
          if (!(err instanceof CalendarEventNotFoundError)) throw err;
        }
      }
      await repo.markAppointmentGoogleSyncDeleted(row.id, attemptNum);
      summary.synced += 1;
      return;
    }

    // google_sync_status === 'pending'
    if (!row.googleEventId) {
      // Fase 6 §2 (seguimiento) — `citas.customers.email` YA existía (columna
      // opcional desde Fase 1); lo único que faltaba era mandarlo aquí.
      // `attendeeEmail` queda `undefined` cuando el cliente no tiene correo
      // guardado — Cal.com puede rechazar un booking sin correo de asistente
      // según la configuración del event type; ese caso lo distingue
      // `isPermanentValidationError` de abajo (rechazo permanente, con un motivo
      // específico) de un fallo transitorio real (que sí sigue reintentando con
      // backoff, sin perder nunca la cita real).
      const event = await calendarPort.createEvent({
        externalCalendarRef,
        summary: buildEventSummary(row),
        description: buildEventDescription(row),
        startTime: row.startsAt,
        endTime: row.endsAt,
        timeZone: row.timeZone,
        attendeeEmail: row.customerEmail ?? undefined,
        attendeeName: row.customerName ?? undefined,
        attendeePhone: row.customerPhone ?? undefined,
      });
      await repo.markAppointmentGoogleSynced(row.id, event.eventId, attemptNum);
    } else {
      await calendarPort.updateEvent({
        externalCalendarRef,
        eventId: row.googleEventId,
        startTime: row.startsAt,
        endTime: row.endsAt,
        timeZone: row.timeZone,
      });
      await repo.markAppointmentGoogleSynced(row.id, row.googleEventId, attemptNum);
    }
    summary.synced += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "sync failed";
    summary.errors.push({ appointmentId: row.id, error: message });

    if (isPermanentAuthError(err)) {
      // Falla PERMANENTE: el proveedor revocó el acceso. Marcar la cuenta en error
      // de una vez evita quemar los 5 intentos de ESTA cita (y de cualquier otra
      // cita futura de este proveedor) contra una credencial que ya sabemos que no
      // sirve — ver diseño §8, riesgo 2.
      await markAccountSyncError(repo, calendarPort.platform, row.providerId, permanentAuthErrorMessage(calendarPort.platform));
      await repo.markAppointmentGoogleSyncExhausted(row.id, attemptNum, "Cuenta desconectada (credencial inválida/revocada) — reconectar el calendario.");
      summary.exhausted += 1;
      return;
    }

    if (isPermanentValidationError(err, calendarPort.platform)) {
      // Fase 6 §2 (seguimiento) — rechazo PERMANENTE de validación: reintentar la
      // MISMA cita con los MISMOS datos nunca va a funcionar (a diferencia de un
      // 5xx/timeout/429, que sí puede resolverse solo), así que se detiene de
      // inmediato sin esperar MAX_SYNC_ATTEMPTS — mismo criterio que
      // isPermanentAuthError arriba, pero SIN tocar la cuenta del proveedor: la
      // credencial sigue sirviendo, esto es sobre ESTA cita en particular (ver
      // diseño de la cabecera del archivo).
      await repo.markAppointmentGoogleSyncInvalid(row.id, attemptNum, permanentValidationReason(err, calendarPort.platform, row));
      summary.invalid += 1;
      return;
    }

    if (attemptNum >= MAX_SYNC_ATTEMPTS) {
      await repo.markAppointmentGoogleSyncExhausted(row.id, attemptNum, message);
      summary.exhausted += 1;
    } else {
      const nextRetry = new Date(now.getTime() + nextSyncBackoffMs(attemptNum)).toISOString();
      await repo.markAppointmentGoogleSyncRetry(row.id, attemptNum, message, nextRetry);
      summary.retried += 1;
    }
  }
}

/**
 * Reconciliación por lote GENÉRICA (Google/Cal.com/CalDAV, cualquier combinación de
 * cuentas conectadas por proveedor) — el cuerpo real del cron
 * (`POST /internal/citas/google-calendar-sync`, ver apps/api): procesa hasta
 * `batchSize` citas con `google_sync_status` en ('pending','pending_cancel') cuyo
 * `google_sync_next_retry_at` ya se cumplió (o nunca se intentó), más viejas
 * primero. Un tenant/proveedor con datos raros nunca tumba la corrida completa de
 * los demás — el error se captura DENTRO de `syncOneAppointmentRow`, nunca aquí.
 */
export async function syncPendingAppointmentsMultiProvider(repo: CitasRepository, resolveSyncPort: ResolveCalendarSyncPort, opts: { now?: Date; batchSize?: number } = {}): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? SYNC_BATCH_SIZE;

  const pending = await repo.loadPendingGoogleSyncAppointments(batchSize, now.toISOString());
  const summary = emptySummary();
  summary.processed = pending.length;
  for (const row of pending) {
    try {
      // Hallazgo CRÍTICO de auditoría (a1, r3) — SAVEPOINT por fila: una fila
      // "venenosa" (cualquier error que escape de `syncOneAppointmentRow`, que ya
      // captura los fallos de sincronización normales -- ver su propio try/catch)
      // NUNCA debe revertir las marcas synced/deleted de las filas YA procesadas
      // en esta misma corrida del batch (ver diseño completo en el comentario de
      // cabecera de `CitasRepository.runWithRowSavepoint`, repository.ts).
      await repo.runWithRowSavepoint(() => syncOneAppointmentRow(repo, resolveSyncPort, row, now, summary));
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "sync failed (fila venenosa, aislada del resto del batch)";
      summary.errors.push({ appointmentId: row.id, error: message });
    }
  }
  return summary;
}

/**
 * Intento inmediato, best-effort, GENÉRICO, justo después de que crear-cita/
 * cancelar-cita/reagendar-cita YA confirmaron el cambio real en la base de datos
 * (ver diseño §5). Un fallo aquí NUNCA se propaga al caller HTTP — la cita ya
 * existe/se canceló/reagendó en el software (fuente de verdad) pase lo que pase con
 * el calendario externo; el cron de reconciliación la recoge en la siguiente
 * corrida gracias a que quedó en 'pending'/'pending_cancel'.
 */
export async function tryTriggerCalendarSync(repo: CitasRepository, resolveSyncPort: ResolveCalendarSyncPort, appointmentId: string, now: Date = new Date()): Promise<SyncSummary> {
  const summary = emptySummary();
  try {
    const row = await repo.loadAppointmentSyncRow(appointmentId);
    if (!row) return summary;
    if (row.googleSyncStatus !== "pending" && row.googleSyncStatus !== "pending_cancel") return summary;
    summary.processed = 1;
    await syncOneAppointmentRow(repo, resolveSyncPort, row, now, summary);
  } catch (err) {
    console.error("tryTriggerCalendarSync: fallo best-effort, el cron de reconciliación lo recogerá:", err);
  }
  return summary;
}

/**
 * Adapta un `ResolveCalendarPort` (SOLO Google, Fase 3) al contrato genérico que el
 * motor de arriba consume — reproduce EXACTAMENTE la compuerta de cuenta original
 * (`findProviderCalendarAccount` + `syncStatus === 'connected'` ANTES de invocar el
 * resolver) para que `syncPendingAppointments`/`tryTriggerGoogleSync` de abajo se
 * comporten idéntico a como se comportaban antes de esta generalización.
 */
function wrapGoogleOnlyResolver(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort): ResolveCalendarSyncPort {
  return async (providerId: string): Promise<ResolvedCalendarSync | null> => {
    const account = await repo.findProviderCalendarAccount(providerId);
    const port = account && account.syncStatus === "connected" ? await resolveCalendarPort(providerId) : null;
    if (!account || !port) return null;
    return { port: new GoogleCalendarSyncAdapter(port), externalCalendarRef: account.googleCalendarId };
  };
}

/**
 * SOLO Google (Fase 3, comportamiento sin cambios — ver la nota de diseño al inicio
 * del archivo). Producción ya NO usa esta función (usa
 * `syncPendingAppointmentsMultiProvider` con un resolver de las tres plataformas,
 * ver apps/api/.../citas/google-calendar-sync.ts); se mantiene exportada porque
 * `tests/calendar-sync.spec.ts` la prueba directo contra un `FakeGoogleCalendarPort`
 * crudo.
 */
export async function syncPendingAppointments(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort, opts: { now?: Date; batchSize?: number } = {}): Promise<SyncSummary> {
  return syncPendingAppointmentsMultiProvider(repo, wrapGoogleOnlyResolver(repo, resolveCalendarPort), opts);
}

/** SOLO Google — ver `syncPendingAppointments` de arriba para el porqué sigue existiendo. */
export async function tryTriggerGoogleSync(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort, appointmentId: string, now: Date = new Date()): Promise<SyncSummary> {
  return tryTriggerCalendarSync(repo, wrapGoogleOnlyResolver(repo, resolveCalendarPort), appointmentId, now);
}
