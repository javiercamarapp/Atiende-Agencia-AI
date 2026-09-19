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
import { diasVencidoCartera, enqueueCollectionReminderEmailForSystemCore, etapaRecordatorioCobranzaHoy } from "@atiende/domain-despachos";
import type { DespachosRepository } from "@atiende/domain-despachos";

/**
 * r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA): runner de
 * sesión inyectado -- CADA llamada abre (o reutiliza, en tests) su PROPIA
 * transacción, nunca una compartida para todo el barrido. Antes de este fix,
 * `runCobranzaReminderSweep` recibía un `DespachosRepository` YA ligado a una
 * única transacción abierta por la ruta para TODAS las organizaciones -- un
 * error SQL real en una organización dejaba esa transacción ABORTADA
 * (Postgres 25P02); las organizaciones siguientes fallaban en cascada, y el
 * COMMIT final devolvía `ROLLBACK` SIN lanzar, revirtiendo en silencio TODO el
 * barrido (incluidos recordatorios de cobranza ya encolados de organizaciones
 * anteriores) -- y como `etapaRecordatorioCobranzaHoy` decide por offset EXACTO
 * de días, ese recordatorio revertido NUNCA se reintenta mañana: se pierde.
 * Ver `WithHotelesRepo` en `../hoteles/night-audit.ts` para el detalle
 * completo del mecanismo (mismo patrón exacto).
 */
export type WithDespachosRepo = <T>(fn: (repo: DespachosRepository) => Promise<T>) => Promise<T>;

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
    // r4-fix-crons-transaccion-por-unidad (auditoría a1b #2, MEDIA, "PEOR de lo
    // reportado"): antes se usaba `tryEnqueueCollectionReminderEmailForSystem`
    // (variante best-effort que atrapa CUALQUIER error, incluido un error SQL
    // real de `systemRecordCollectionEvent`/`enqueueMessagingOutbox`, y
    // devuelve `null`) -- un error SQL ahí quedaba invisible: no aparecía en
    // `failures[]`, la ruta respondía `ok:true`, y (con la transacción
    // compartida de antes) el COMMIT final revertía TODO el barrido en
    // silencio. Con la transacción POR organización de este fix, un error real
    // aquí debe PROPAGARSE -- lo captura el catch por organización de
    // `runCobranzaReminderSweep` (que reporta el error real en `failures[]` y
    // hace ROLLBACK limpio de SOLO esa organización, vía `withRepo`), nunca se
    // traga en silencio. El correo best-effort (nunca se manda dos veces por
    // un reintento) sigue siendo el criterio correcto para el ENVÍO real
    // (`email-dispatch.ts`/Resend) -- lo que cambia es que escribir el evento
    // de auditoría/encolar en el outbox SÍ debe poder fallar la corrida de esa
    // organización si Postgres realmente falló.
    const resultado = await enqueueCollectionReminderEmailForSystemCore(repo, receivable, etapa, diasVencido, todayIso);
    if (resultado.enqueued) emailsEnqueued += 1;
  }

  return { propertyId, receivablesScanned: pendientes.length, remindersDue, emailsEnqueued };
}

/**
 * EL barrido real que un scheduler externo debe invocar periódicamente.
 * Aislamiento COMPLETO por organización (mismo criterio que
 * `runAlertNotificationSweep`): un tenant con datos raros en cualquiera de
 * sus properties nunca detiene el barrido de las demás organizaciones.
 *
 * r4-fix-crons-transaccion-por-unidad: `listActiveOrganizations()` corre en su
 * propia transacción corta, y CADA organización corre la suya -- ver
 * `WithDespachosRepo` arriba para la razón exacta.
 */
export async function runCobranzaReminderSweep(withRepo: WithDespachosRepo, options: RunCobranzaReminderSweepOptions = {}): Promise<readonly CobranzaReminderSweepResult[]> {
  const todayIso = options.todayIsoDate ?? new Date().toISOString().slice(0, 10);
  const organizations = await withRepo((repo) => repo.listActiveOrganizations());
  const results: CobranzaReminderSweepResult[] = [];

  for (const org of organizations) {
    try {
      const propertyResults = await withRepo(async (repo) => {
        const properties = await repo.listPropertiesForOrganization(org.id);
        const out: CobranzaReminderPropertyResult[] = [];
        for (const property of properties) {
          out.push(await sweepProperty(repo, property.propertyId, todayIso));
        }
        return out;
      });
      results.push({ organizationId: org.id, properties: propertyResults });
    } catch (err) {
      results.push({ organizationId: org.id, properties: [], error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}
