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
// escanea la cartera pendiente (`repo.listReceivables(propertyId,
// {pendiente:true})`), decide con el motor puro
// (`etapaRecordatorioCobranzaHoy`/`diasVencidoCartera`, ambos ya verificados
// en `cobranza/engine.ts`) si HOY toca recordatorio para cada cuenta, y si
// toca, encola el correo real + dedupe_key vía
// `cobranza/email-notifications.ts::tryEnqueueCollectionReminderEmail` --
// best-effort real: una cuenta/property/organización con datos raros nunca
// tumba el barrido de las demás.
import { diasVencidoCartera, etapaRecordatorioCobranzaHoy, tryEnqueueCollectionReminderEmail } from "@atiende/domain-despachos";
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
  const pendientes = await repo.listReceivables(propertyId, { pendiente: true });
  let remindersDue = 0;
  let emailsEnqueued = 0;

  for (const receivable of pendientes) {
    const etapa = etapaRecordatorioCobranzaHoy(receivable.fechaVencimiento, todayIso);
    if (!etapa) continue;
    remindersDue += 1;

    const invoice = await repo.findInvoice(propertyId, receivable.invoiceId);
    // Un receivable siempre nace de un invoice ya ingerido (`registerReceivable`
    // exige `invoiceId` real) -- si ya no se encuentra, es un dato inconsistente
    // de ESTA cuenta puntual; se salta sin tumbar el resto de la cartera.
    if (!invoice) continue;

    const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, todayIso);
    const resultado = await tryEnqueueCollectionReminderEmail(repo, receivable, { facturaId: invoice.folioFiscal, monto: invoice.total }, etapa, diasVencido);
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
