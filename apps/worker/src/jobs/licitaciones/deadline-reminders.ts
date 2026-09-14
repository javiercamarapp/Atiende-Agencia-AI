// Fase 8 licitaciones — recordatorios automáticos de plazo (gap identificado
// por la auditoría: "recordatorios automáticos de plazo" faltantes). Puerto
// ADAPTADO (no literal) de
// `apps/worker/src/scheduler/deadline-reminders.ts::enqueueUpcomingDeadlineReminders`
// del repo origen, sin la cola de jobs genérica del origen (`JobQueue`/
// `enqueueAgentRun`, que Fusion no porta todavía -- ningún otro vertical de
// este monorepo tiene un mecanismo de jobs asíncronos genérico, ver
// `LicitacionesRepository.scanUpcomingDeadlineReminders`): el equivalente
// honesto aquí es el MISMO patrón que ya usa `tender_change_notification`
// (migración 010) -- un registro persistido y consultable, deduplicado,
// SIN canal de envío real (email/SMS/WhatsApp es un gap declarado, no una
// integración fingida).
//
// MISMO patrón de invocación (sin scheduler en proceso) que
// `discover-tenders.ts`/`jobs/hoteles/night-audit.ts` -- ver su comentario
// de cabecera para la decisión completa.
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";

export interface RunDeadlineRemindersOptions {
  /** Ventana de anticipación (días) -- default 3 (mismo valor que el repo origen). */
  readonly windowDays?: number;
  /** Reloj inyectable para pruebas deterministas -- default `() => new Date()`. */
  readonly now?: () => Date;
}

export interface DeadlineReminderSweepResult {
  readonly organizationId: string;
  readonly scanned: number;
  readonly created: number;
  readonly error?: string;
}

/**
 * Escanea TODAS las organizaciones activas del vertical buscando
 * convocatorias con `submissionDeadline` dentro de la ventana de
 * anticipación, y persiste un recordatorio nuevo por cada una que no exista
 * todavía (`LicitacionesRepository.scanUpcomingDeadlineReminders`, dedupe
 * real en la capa de datos). Un tenant con datos raros nunca detiene el
 * barrido de los demás (mismo criterio que `citasRemindersRoutes`/
 * `runNightAuditSweep`/`runDiscoverTendersSweep`).
 */
export async function runDeadlineReminderSweep(repo: LicitacionesRepository, options: RunDeadlineRemindersOptions = {}): Promise<readonly DeadlineReminderSweepResult[]> {
  const now = options.now ?? (() => new Date());
  const organizations = await repo.listActiveOrganizations();
  const results: DeadlineReminderSweepResult[] = [];

  for (const org of organizations) {
    try {
      const result = await repo.scanUpcomingDeadlineReminders(org.id, { windowDays: options.windowDays, nowIso: now().toISOString() });
      results.push({ organizationId: org.id, scanned: result.scanned, created: result.created });
    } catch (err) {
      results.push({ organizationId: org.id, scanned: 0, created: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
