// runCobranzaReminderSweep — el barrido REAL que un scheduler externo (Vercel
// Cron/Supabase Cron) debe invocar periódicamente para despachar recordatorios
// de cobranza (ver `POST /internal/despachos/cobranza-reminders` en
// `apps/api/src/routes/verticals/despachos/notifications.ts`). Cierra el gap
// de auditoría (severidad ALTA) documentado en
// `packages/domain-despachos/src/cobranza/engine.ts`/README.md: el motor de
// cobranza (`construirRecordatorioCobranza`) generaba contenido real pero
// NADA lo despachaba proactivamente — alguien tenía que invocarlo a mano por
// cada cuenta por cobrar.
//
// Mismo patrón EXACTO que `apps/worker/src/jobs/licitaciones/alert-
// notifications.ts::runAlertNotificationSweep` (leído primero como
// plantilla): por cada organización activa (`repo.listActiveOrganizations`),
// por cada property de esa organización (`repo.listPropertiesForOrganization`
// -- despachos SÍ particiona por property, a diferencia de licitaciones),
// escanea la cartera pendiente, decide con el motor puro
// (`etapaRecordatorioCobranzaHoy`/`diasVencidoCartera`, ambos ya verificados
// en `cobranza/engine.ts`) si HOY toca recordatorio para cada cuenta, y si
// toca, encola el correo real + dedupe_key vía
// `cobranza/email-notifications.ts::tryEnqueueCollectionReminderEmailForSystem`
// -- best-effort real: una cuenta/property/organización con datos raros nunca
// tumba el barrido de las demás.
//
// Hallazgo de auditoría cerrado por esta versión del archivo (severidad ALTA,
// "flujos de sistema bloqueados en escritura", ver
// `packages/domain-despachos/migrations/009_despachos_sistema_cobranza_
// escritura.sql`): este job corre bajo `deps.engine.withAppSession({ userId:
// null })` (ver `apps/api/src/routes/verticals/despachos/notifications.ts`),
// pero `repo.listReceivables`/`repo.findInvoice`/`repo.insertCollectionEvent`
// (usados antes por este archivo) son código COMPARTIDO con el staff
// autenticado (panel de cartera + `POST .../recordatorio`, ver
// `apps/api/src/routes/verticals/despachos/cobranza.ts`) -- policies
// `core.has_property_access`/`hoteles.can_access_money`-like, sin escape
// hatch, SIEMPRE bloqueadas bajo sesión de sistema. Se sustituyen aquí, y
// SOLO aquí, por `repo.systemListPendingReceivablesForReminders`/
// `tryEnqueueCollectionReminderEmailForSystem` -- exclusivas de este barrido,
// respaldadas por funciones `security definer` de solo-sistema (ver esa
// migración) -- el panel/`/recordatorio` de staff siguen sin cambios.
import { diasVencidoCartera, etapaRecordatorioCobranzaHoy, tryEnqueueCollectionReminderEmailForSystem } from "@atiende/domain-despachos";
import type { DespachosRepository } from "@atiende/domain-despachos";

export interface RunCobranzaReminderSweepOptions {
  /** Inyectable SOLO para pruebas deterministas -- por defecto la fecha real de hoy. */
  readonly todayIsoDate?: string;
}

export interface CobranzaReminderPropertyResult {
  readonly propertyId: string;
  readonly receivablesScanned: number;
  readonly remindersDue: number;
  readonly emailsEnqueued: number;
}

export interface CobranzaReminderSweepResult {
  readonly organizationId: string;
  readonly properties: readonly CobranzaReminderPropertyResult[];
  readonly error?: string;
}

async function sweepProperty(repo: DespachosRepository, propertyId: string, todayIso: string): Promise<CobranzaReminderPropertyResult> {
  // `systemListPendingReceivablesForReminders` ya trae el folio fiscal/total del
  // invoice asociado (join interno, security definer) -- ya no hace falta un
  // `findInvoice` aparte por cuenta (antes bloqueado igual bajo sesión de sistema).
  const pendientes = await repo.systemListPendingReceivablesForReminders(propertyId);
  let remindersDue = 0;
  let emailsEnqueued = 0;

  for (const receivable of pendientes) {
    const etapa = etapaRecordatorioCobranzaHoy(receivable.fechaVencimiento, todayIso);
    if (!etapa) continue;
    remindersDue += 1;

    const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, todayIso);
    const resultado = await tryEnqueueCollectionReminderEmailForSystem(repo, receivable, etapa, diasVencido, todayIso);
    if (resultado?.enqueued) emailsEnqueued += 1;
  }

  return { propertyId, receivablesScanned: pendientes.length, remindersDue, emailsEnqueued };
}

/**
 * EL barrido real que un scheduler externo debe invocar periódicamente.
 * Aislamiento COMPLETO por organización (mismo criterio que
 * `runAlertNotificationSweep`): un tenant con datos raros en cualquiera de
 * sus properties nunca detiene el barrido de las demás organizaciones.
 */
export async function runCobranzaReminderSweep(repo: DespachosRepository, options: RunCobranzaReminderSweepOptions = {}): Promise<readonly CobranzaReminderSweepResult[]> {
  const todayIso = options.todayIsoDate ?? new Date().toISOString().slice(0, 10);
  const organizations = await repo.listActiveOrganizations();
  const results: CobranzaReminderSweepResult[] = [];

  for (const org of organizations) {
    try {
      const properties = await repo.listPropertiesForOrganization(org.id);
      const propertyResults: CobranzaReminderPropertyResult[] = [];
      for (const property of properties) {
        propertyResults.push(await sweepProperty(repo, property.propertyId, todayIso));
      }
      results.push({ organizationId: org.id, properties: propertyResults });
    } catch (err) {
      results.push({ organizationId: org.id, properties: [], error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
