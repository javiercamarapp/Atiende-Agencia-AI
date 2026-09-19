// Fase 10 licitaciones — despacho proactivo REAL de las 3 alertas que hasta
// esta fase eran solo REGISTROS consultables manualmente (gap identificado
// por la auditoría de paridad): `tender_deadline_reminder` (Fase 8, ya
// escaneado por `./deadline-reminders.ts`), `renewal_alert` (Fase 6, hasta
// ahora solo disparado a mano desde el panel vía `POST .../renewals/scan`,
// ver `apps/api/src/routes/verticals/licitaciones/renewalRadar.ts` — SIN
// barrido periódico transversal, el mismo gap exacto que tenían los
// recordatorios de plazo antes de la Fase 8) y las facturas vencidas de
// cobranza (Fase 6, `contract_invoice`, hasta ahora solo un `status`
// calculado en vivo que alguien debía abrir el panel para ver).
//
// MISMO patrón de invocación (sin scheduler en proceso) que
// `./deadline-reminders.ts`/`./discover-tenders.ts` (leídos primero como
// plantilla): este archivo expone solo la lógica de orquestación, isolando
// por organización (un tenant con datos raros nunca detiene el barrido de
// los demás) — la ruta HTTP interna que lo invoca vive en
// `apps/api/src/routes/verticals/licitaciones/alertNotifications.ts`.
//
// `runAlertNotificationSweep` es la función real que un scheduler externo
// (Vercel Cron/Supabase Cron) debe llamar periódicamente: por cada
// organización activa, (1) escanea recordatorios de plazo nuevos vía
// `repo.scanUpcomingDeadlineReminders` (el MISMO método de dominio que ya usa
// `runDeadlineReminderSweep` de `./deadline-reminders.ts`, Fase 8 -- se llama
// aquí directo en vez de a través de ese wrapper porque `runAlertNotificationSweep`
// necesita las filas `TenderDeadlineReminderRecord` creadas para poder
// encolarles correo, y `DeadlineReminderSweepResult` -- el tipo de retorno
// público de `runDeadlineReminderSweep`, ya usado por sus propios tests --
// deliberadamente solo expone conteos, nunca se le agregó ese campo para no
// tocar un contrato ya probado de una fase anterior; `runDeadlineReminderSweep`
// SIGUE siendo la función correcta para un barrido de SOLO recordatorios sin
// despacho de correo, ver `POST /internal/licitaciones/deadline-reminders`),
// (2) escanea alertas de renovación nuevas (`repo.scanRenewalAlerts`, YA
// EXISTENTE desde Fase 6), (3) lista facturas vencidas
// (`repo.listOverdueContractInvoices`, nuevo en esta fase), y por cada
// alerta/factura encontrada ENCOLA un correo real al responsable de la
// organización (`@atiende/domain-licitaciones::alert-notifications.ts`,
// que a su vez usa el MISMO motor de correo vía Resend que citas/rentas ya
// tienen — nunca se reinventa un canal nuevo).
import { tryEnqueueDeadlineReminderEmails, tryEnqueueOverdueInvoiceEmails, tryEnqueueRenewalAlertEmails } from "@atiende/domain-licitaciones";
import type { LicitacionesRepository, ScanRenewalAlertsInput } from "@atiende/domain-licitaciones";

/**
 * r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA): runner de
 * sesión inyectado -- CADA llamada abre (o reutiliza, en tests) su PROPIA
 * transacción, nunca una compartida para todo el barrido. Ver `WithHotelesRepo`
 * en `../hoteles/night-audit.ts` para el detalle completo del mecanismo
 * (mismo patrón exacto: COMMIT sobre una transacción abortada devuelve
 * `ROLLBACK` sin lanzar, revirtiendo en silencio TODAS las organizaciones ya
 * procesadas en esa corrida).
 */
export type WithLicitacionesRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => Promise<T>;

export interface RunRenewalAlertSweepOptions {
  readonly leadDaysThresholds?: readonly number[];
  /** Inyectable SOLO para pruebas deterministas -- por defecto la fecha real de hoy. */
  readonly todayIsoDate?: string;
}

export interface RenewalAlertSweepResult {
  readonly organizationId: string;
  readonly evaluatedContracts: number;
  readonly alertsCreated: number;
  readonly error?: string;
}

/**
 * Barrido transversal (TODAS las organizaciones activas) de
 * `repo.systemScanRenewalAlerts` — hasta esta fase esa función solo se invocaba
 * manualmente desde `POST .../renewals/scan` (un usuario tenía que abrir el
 * panel y darle clic), nunca por un scheduler externo. Mismo criterio de
 * aislamiento por organización que `runDeadlineReminderSweep`.
 *
 * Hallazgo de auditoría cerrado por esta versión del archivo (severidad ALTA,
 * "flujos de sistema bloqueados en escritura", ver `packages/domain-
 * licitaciones/migrations/025_licitaciones_sistema_renovaciones_facturas.sql`):
 * este job corre bajo `deps.engine.withAppSession({ userId: null })` -- usa
 * `repo.systemScanRenewalAlerts` (exclusiva de sistema, respaldada por
 * funciones `security definer` de solo-sistema) en vez de `repo.
 * scanRenewalAlerts` (código compartido con el staff autenticado de `POST
 * .../renewals/scan`, `renewalRadar.ts` -- ESE camino sigue llamando a
 * `scanRenewalAlerts` sin cambios).
 */
export async function runRenewalAlertSweep(repo: LicitacionesRepository, options: RunRenewalAlertSweepOptions = {}): Promise<readonly RenewalAlertSweepResult[]> {
  const organizations = await repo.listActiveOrganizations();
  const results: RenewalAlertSweepResult[] = [];

  for (const org of organizations) {
    try {
      const input: ScanRenewalAlertsInput = { leadDaysThresholds: options.leadDaysThresholds, todayIsoDate: options.todayIsoDate };
      const result = await repo.systemScanRenewalAlerts(org.id, input);
      results.push({ organizationId: org.id, evaluatedContracts: result.evaluatedContracts, alertsCreated: result.alertsCreated });
    } catch (err) {
      results.push({ organizationId: org.id, evaluatedContracts: 0, alertsCreated: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}

export interface RunCollectionAlertSweepOptions {
  /** Inyectable SOLO para pruebas deterministas -- por defecto la fecha real de hoy. */
  readonly todayIsoDate?: string;
}

export interface CollectionAlertSweepResult {
  readonly organizationId: string;
  readonly overdueInvoices: number;
  readonly error?: string;
}

/** Barrido transversal de `repo.listOverdueContractInvoices` -- a diferencia de `scanRenewalAlerts`/`scanUpcomingDeadlineReminders`, esta lectura NUNCA crea una fila nueva (no hay tabla de "alerta de cobranza" propia, ver comentario de cabecera de `migrations/018_alert_notifications.sql`): simplemente re-lista lo que sigue vencido en cada corrida -- el dedupe real de "ya se avisó" vive en el dedupe_key del outbox (ver `alert-notifications.ts::enqueueOverdueInvoiceEmailsCore`). */
export async function runCollectionAlertSweep(repo: LicitacionesRepository, options: RunCollectionAlertSweepOptions = {}): Promise<readonly CollectionAlertSweepResult[]> {
  const organizations = await repo.listActiveOrganizations();
  const results: CollectionAlertSweepResult[] = [];

  for (const org of organizations) {
    try {
      const overdue = await repo.listOverdueContractInvoices(org.id, options.todayIsoDate);
      results.push({ organizationId: org.id, overdueInvoices: overdue.length });
    } catch (err) {
      results.push({ organizationId: org.id, overdueInvoices: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}

export interface RunAlertNotificationSweepOptions {
  /** Ventana de anticipación (días) de recordatorios de plazo -- pasa directo a `runDeadlineReminderSweep`. */
  readonly deadlineWindowDays?: number;
  readonly renewalLeadDaysThresholds?: readonly number[];
  /** Reloj/fecha inyectables SOLO para pruebas deterministas -- por defecto el momento real de la corrida. */
  readonly now?: () => Date;
  readonly todayIsoDate?: string;
}

export interface AlertNotificationSweepResult {
  readonly organizationId: string;
  readonly deadlineReminders: { readonly scanned: number; readonly created: number; readonly emailsEnqueued: number };
  readonly renewalAlerts: { readonly evaluatedContracts: number; readonly alertsCreated: number; readonly emailsEnqueued: number };
  readonly collectionAlerts: { readonly overdueInvoices: number; readonly emailsEnqueued: number };
  readonly error?: string;
}

const EMPTY_ORG_RESULT = { deadlineReminders: { scanned: 0, created: 0, emailsEnqueued: 0 }, renewalAlerts: { evaluatedContracts: 0, alertsCreated: 0, emailsEnqueued: 0 }, collectionAlerts: { overdueInvoices: 0, emailsEnqueued: 0 } };

/**
 * EL barrido real que un scheduler externo debe invocar periódicamente (ver
 * `POST /internal/licitaciones/alert-notifications` en
 * `apps/api/src/routes/verticals/licitaciones/alertNotifications.ts`): por
 * cada organización activa, escanea las 3 fuentes de alerta y encola un
 * correo real por cada alerta nueva/factura vencida encontrada. Aislamiento
 * por organización COMPLETO (mismo criterio que `runDeadlineReminderSweep`):
 * un tenant con datos raros en cualquiera de los 3 pasos nunca detiene el
 * barrido de los demás -- las 3 sub-operaciones de una MISMA organización sí
 * comparten un solo try/catch (si el escaneo de recordatorios de plazo falla
 * para una organización, no tiene sentido seguir intentando renovación/
 * cobranza para esa misma organización en esta corrida; la siguiente corrida
 * lo reintenta).
 *
 * r4-fix-crons-transaccion-por-unidad: `listActiveOrganizations()` corre en su
 * propia transacción corta (vía `withRepo`), y CADA organización corre la
 * suya -- las 3 sub-operaciones de una misma organización SIGUEN compartiendo
 * una sola transacción (documentado arriba: "no tiene sentido seguir
 * intentando renovación/cobranza si el escaneo de plazo ya falló para esa
 * organización"), pero esa transacción YA NO se extiende a las demás
 * organizaciones -- ver `WithLicitacionesRepo` arriba para la razón exacta.
 */
export async function runAlertNotificationSweep(withRepo: WithLicitacionesRepo, options: RunAlertNotificationSweepOptions = {}): Promise<readonly AlertNotificationSweepResult[]> {
  const organizations = await withRepo((repo) => repo.listActiveOrganizations());
  const results: AlertNotificationSweepResult[] = [];

  for (const org of organizations) {
    try {
      const result = await withRepo(async (repo) => {
        // ---- 1) Recordatorios de plazo (Fase 8, reusa runDeadlineReminderSweep tal cual, sin reimplementar el escaneo). ----
        const deadlineScan = await repo.scanUpcomingDeadlineReminders(org.id, { windowDays: options.deadlineWindowDays, nowIso: options.now ? options.now().toISOString() : undefined });
        const deadlineEmails = await tryEnqueueDeadlineReminderEmails(repo, org.id, deadlineScan.reminders);

        // ---- 2) Alertas de renovación (Fase 6, `scanRenewalAlerts` ya existía -- lo nuevo es invocarlo desde un barrido transversal). `systemScanRenewalAlerts`: ver comentario de cabecera de `runRenewalAlertSweep`, arriba -- exclusiva de sesión de sistema. ----
        const renewalScan = await repo.systemScanRenewalAlerts(org.id, { leadDaysThresholds: options.renewalLeadDaysThresholds, todayIsoDate: options.todayIsoDate });
        const renewalEmails = await tryEnqueueRenewalAlertEmails(repo, org.id, renewalScan.alerts);

        // ---- 3) Facturas vencidas de cobranza (Fase 6, nueva lectura transversal en esta fase). ----
        const overdueInvoices = await repo.listOverdueContractInvoices(org.id, options.todayIsoDate);
        const collectionEmails = await tryEnqueueOverdueInvoiceEmails(repo, org.id, overdueInvoices);

        return {
          organizationId: org.id,
          deadlineReminders: { scanned: deadlineScan.scanned, created: deadlineScan.created, emailsEnqueued: deadlineEmails.enqueued },
          renewalAlerts: { evaluatedContracts: renewalScan.evaluatedContracts, alertsCreated: renewalScan.alertsCreated, emailsEnqueued: renewalEmails.enqueued },
          collectionAlerts: { overdueInvoices: overdueInvoices.length, emailsEnqueued: collectionEmails.enqueued },
        };
      });
      results.push(result);
    } catch (err) {
      results.push({ organizationId: org.id, ...EMPTY_ORG_RESULT, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
