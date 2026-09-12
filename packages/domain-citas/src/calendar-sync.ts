// Motor de sincronización a Google Calendar — port de
// citas-reservaciones/supabase/functions/_shared/calendar-sync-core.ts
// (`syncPendingAppointments`/`trySyncAppointmentNow`) sobre `CitasRepository` en vez
// de un cliente supabase-js crudo. Ver diseño Fase 3 §5/§6/§8.
//
// Principio que gobierna TODO este archivo, igual que el origen: "el software es la
// fuente de verdad. Google Calendar es downstream: se sincroniza después de que el
// INSERT/UPDATE en la base de datos fue exitoso." Nada aquí escribe
// `status`/`starts_at`/`ends_at` de una cita — solo lee esas columnas (ya
// congeladas por create/cancel/reschedule_appointment_idempotent) y escribe el
// resultado de sincronizarlas hacia Google en `google_sync_*`.
import { CalendarEventNotFoundError, isInvalidGrantError } from "./google-calendar-port.ts";
import type { GoogleCalendarPort } from "./google-calendar-port.ts";
import type { AppointmentSyncRow, CitasRepository } from "./repository.ts";

/**
 * Resuelve el GoogleCalendarPort a usar para UN proveedor concreto (cada proveedor
 * tiene su propio refresh token OAuth), o `null` cuando ese proveedor no tiene forma
 * de sincronizar todavía (sin conectar, credenciales de plataforma pendientes, o
 * cuenta marcada en error) — el caller lo trata igual que "sin calendario
 * conectado": skip, nunca un error a reintentar. Producción:
 * `createGoogleCalendarPortResolver` (google-calendar-factory.ts); pruebas: un
 * resolver fijo sobre un `FakeGoogleCalendarPort` (ver google-calendar-port.ts).
 */
export type ResolveCalendarPort = (providerId: string) => Promise<GoogleCalendarPort | null>;

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
  skipped: number;
  errors: { appointmentId: string; error: string }[];
}

function emptySummary(): SyncSummary {
  return { processed: 0, synced: 0, retried: 0, exhausted: 0, skipped: 0, errors: [] };
}

function buildEventSummary(row: AppointmentSyncRow): string {
  return `${row.serviceName ?? "Cita"} - ${row.customerName ?? "Cliente"}`;
}

function buildEventDescription(row: AppointmentSyncRow): string {
  const lines = [`Tel: ${row.customerPhone ?? "N/D"}`, "Agendada por atiende.ai"];
  if (row.notes) lines.unshift(row.notes);
  return lines.join("\n");
}

/**
 * Procesa UNA fila pendiente. Nunca lanza por un fallo de Google — lo absorbe,
 * calcula el próximo backoff (o marca la cuenta desconectada de una vez si el error
 * es un `invalid_grant` permanente, ver diseño §8), y lo deja escrito en la fila
 * para que la siguiente corrida (o `tryTriggerGoogleSync`) lo reintente. Un fallo
 * real de la base de datos (leer/escribir la cita) sí se propaga — eso debe detener
 * la corrida, nunca absorberse en silencio.
 */
async function syncOneAppointmentRow(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort, row: AppointmentSyncRow, now: Date, summary: SyncSummary): Promise<void> {
  const account = await repo.findProviderCalendarAccount(row.providerId);
  const calendarPort = account && account.syncStatus === "connected" ? await resolveCalendarPort(row.providerId) : null;
  if (!account || !calendarPort) {
    // Sin calendario conectado, cuenta en error, o sin credenciales de plataforma
    // configuradas todavía — skip permanente, no es un error a reintentar.
    await repo.markAppointmentGoogleSyncSkipped(row.id);
    summary.skipped += 1;
    return;
  }

  const attemptNum = row.googleSyncAttempts + 1;

  try {
    if (row.googleSyncStatus === "pending_cancel") {
      if (row.googleEventId) {
        try {
          await calendarPort.deleteEvent({ calendarId: account.googleCalendarId, eventId: row.googleEventId });
        } catch (err) {
          // Ya no existía en Google -> el estado deseado (que no exista) ya se
          // cumple; no es un fallo de sincronización (ver google-calendar-port.ts).
          if (!(err instanceof CalendarEventNotFoundError)) throw err;
        }
      }
      await repo.markAppointmentGoogleSyncDeleted(row.id, attemptNum);
      summary.synced += 1;
      return;
    }

    // google_sync_status === 'pending'
    if (!row.googleEventId) {
      const event = await calendarPort.createEvent({
        calendarId: account.googleCalendarId,
        summary: buildEventSummary(row),
        description: buildEventDescription(row),
        startTime: row.startsAt,
        endTime: row.endsAt,
        timeZone: row.timeZone,
      });
      await repo.markAppointmentGoogleSynced(row.id, event.eventId, attemptNum);
    } else {
      await calendarPort.updateEvent({
        calendarId: account.googleCalendarId,
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

    if (isInvalidGrantError(err)) {
      // Falla PERMANENTE: el proveedor revocó el acceso. Marcar la cuenta en error
      // de una vez evita quemar los 5 intentos de ESTA cita (y de cualquier otra
      // cita futura de este proveedor) contra un token que ya sabemos que no sirve
      // — ver diseño §8, riesgo 2.
      await repo.setProviderCalendarAccountSyncError(row.providerId, "Google revocó el acceso (invalid_grant) — el proveedor debe reconectar su Google Calendar.");
      await repo.markAppointmentGoogleSyncExhausted(row.id, attemptNum, "Cuenta de Google desconectada (invalid_grant) — reconectar el calendario.");
      summary.exhausted += 1;
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
 * Reconciliación por lote — el cuerpo real del cron
 * (`POST /internal/citas/google-calendar-sync`, ver apps/api): procesa hasta
 * `batchSize` citas con `google_sync_status` en ('pending','pending_cancel') cuyo
 * `google_sync_next_retry_at` ya se cumplió (o nunca se intentó), más viejas
 * primero. Un tenant/proveedor con datos raros nunca tumba la corrida completa de
 * los demás — el error se captura DENTRO de `syncOneAppointmentRow`, nunca aquí.
 */
export async function syncPendingAppointments(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort, opts: { now?: Date; batchSize?: number } = {}): Promise<SyncSummary> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? SYNC_BATCH_SIZE;

  const pending = await repo.loadPendingGoogleSyncAppointments(batchSize, now.toISOString());
  const summary = emptySummary();
  summary.processed = pending.length;
  for (const row of pending) {
    await syncOneAppointmentRow(repo, resolveCalendarPort, row, now, summary);
  }
  return summary;
}

/**
 * Intento inmediato, best-effort, justo después de que crear-cita/cancelar-cita/
 * reagendar-cita YA confirmaron el cambio real en la base de datos (ver diseño §5).
 * Un fallo aquí NUNCA se propaga al caller HTTP — la cita ya existe/se
 * canceló/reagendó en el software (fuente de verdad) pase lo que pase con Google;
 * el cron de reconciliación la recoge en la siguiente corrida gracias a que quedó
 * en 'pending'/'pending_cancel'.
 */
export async function tryTriggerGoogleSync(repo: CitasRepository, resolveCalendarPort: ResolveCalendarPort, appointmentId: string, now: Date = new Date()): Promise<SyncSummary> {
  const summary = emptySummary();
  try {
    const row = await repo.loadAppointmentSyncRow(appointmentId);
    if (!row) return summary;
    if (row.googleSyncStatus !== "pending" && row.googleSyncStatus !== "pending_cancel") return summary;
    summary.processed = 1;
    await syncOneAppointmentRow(repo, resolveCalendarPort, row, now, summary);
  } catch (err) {
    console.error("tryTriggerGoogleSync: fallo best-effort, el cron de reconciliación lo recogerá:", err);
  }
  return summary;
}
