// L-04 -- recordatorios de la fecha limite de envio de preguntas a la junta de
// aclaraciones. Es el MISMO servicio de recordatorios de plazo de
// `deadline-reminders.ts` (mismo cron `/internal/licitaciones/deadline-reminders`,
// mismo patron: un registro persistido, deduplicado por convocatoria y dia, SIN canal
// de envio real) aplicado a un segundo plazo: `junta_aclaraciones.questions_deadline_at`.
// Solo recuerda cuando todavia hay preguntas sin enviar (borrador/aprobada).
//
// UNA transaccion POR organizacion (mismo criterio que `runDeadlineReminderSweep`):
// un error en una organizacion no contagia a las demas. Base sin migrar (migracion
// 029 pendiente): `SalaGuerraNotAvailableError` se reporta como `unavailable: true`,
// nunca como fallo del barrido -- al ser su propia transaccion, atrapar el error aqui
// es seguro (el repositorio ya hizo ROLLBACK TO SAVEPOINT).
import { SalaGuerraNotAvailableError } from "@atiende/domain-licitaciones";
import type { SalaGuerraRepository } from "@atiende/domain-licitaciones";

export type WithSalaGuerraRepo = <T>(fn: (repo: SalaGuerraRepository) => Promise<T>) => Promise<T>;

export interface RunJuntaQuestionRemindersOptions {
  /** Ventana de anticipacion (dias) -- default 3, igual que los recordatorios de plazo de presentacion. */
  readonly windowDays?: number;
  readonly now?: () => Date;
}

export interface JuntaQuestionReminderSweepResult {
  readonly organizationId: string;
  readonly created: number;
  /** `true` si la base aun no tiene la migracion 029 (no es un fallo). */
  readonly unavailable?: boolean;
  readonly error?: string;
}

export async function runJuntaQuestionReminderSweep(
  organizationIds: readonly string[],
  withSalaRepo: WithSalaGuerraRepo,
  options: RunJuntaQuestionRemindersOptions = {},
): Promise<readonly JuntaQuestionReminderSweepResult[]> {
  const now = options.now ?? (() => new Date());
  const results: JuntaQuestionReminderSweepResult[] = [];
  for (const organizationId of organizationIds) {
    try {
      const scan = await withSalaRepo((repo) => repo.scanJuntaQuestionReminders(organizationId, { windowDays: options.windowDays, nowIso: now().toISOString() }));
      results.push({ organizationId, created: scan.created });
    } catch (err) {
      if (err instanceof SalaGuerraNotAvailableError) results.push({ organizationId, created: 0, unavailable: true });
      else results.push({ organizationId, created: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
