// Port REAL (no solo el nombre) de runConfirmacionCitaCore + el aviso best-effort a
// lista de espera (runOptimizadorCore/tryNotifyWaitlistOfFreedSlot/
// notifyWaitlistAfterReschedule) de
// citas-reservaciones/supabase/functions/_shared/agenda-agents-core.ts.
//
// FIX DE TIMEZONE REAL preservado literal (comentario original: el host donde corre
// esta función corre en UTC — la hora que se le muestra al cliente SIEMPRE se
// calcula con el timezone real del NEGOCIO, sea el de la sucursal del proveedor si
// existe o el de la organización, nunca el del host). Ver diseño Fase 1 §0.4/§5.3:
// es la pieza de mayor riesgo silencioso de todo el vertical — un bug de timezone no
// falla ruidosamente, solo le dice al cliente la hora equivocada.
import { tryEnqueueAppointmentEmail } from "./appointment-email-notifications.ts";
import type { CitasRepository, WaitlistCandidateRow } from "./repository.ts";

/** Rate-limit real: nadie recibe más de esto por su entrada en la lista de espera. */
export const MAX_WAITLIST_NOTIFICATIONS = 3;

const REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;
// El cron real corre cada tantos minutos, no exactamente a las 24h — una ventana de
// tolerancia evita que una cita se quede sin recordatorio por caer 2 minutos fuera
// de un corte exacto, y evita mandarlo dos veces gracias a reminder24hSentAt.
const REMINDER_WINDOW_TOLERANCE_MS = 30 * 60 * 1000;

export type TimeWindow = "morning" | "afternoon" | "evening";

/** Hora local (0-23) de `date` en `timeZone`. */
function zonedHour(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(date));
}

/** Franja horaria real del slot, calculada con el timezone del NEGOCIO — nunca con el del host. */
export function timeWindowFor(date: Date, timeZone: string): TimeWindow {
  const hour = zonedHour(date, timeZone);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export interface ConfirmacionCitaSummary {
  readonly organizationId: string;
  processed: number;
  sent: number;
  /** Fase 6 §3 — recordatorios reales por correo encolados en esta corrida (canal
   * independiente del de WhatsApp: un negocio SIN WhatsApp configurado sigue
   * recibiendo este canal si el cliente dejó correo — ver comentario más abajo). */
  sentEmail: number;
  skippedNoPhone: number;
  skippedNoWhatsappConfig: boolean;
  /** Auditoría a3 (hallazgo confirmado #7) — ids de citas cuyo procesamiento
   * lanzó un error REAL (no capturado por los best-effort internos de WhatsApp/
   * correo) dentro de esta corrida. Cada iteración corre bajo su propio
   * `repo.runWithRowSavepoint` (aislamiento por fila, mismo mecanismo que
   * `syncPendingAppointmentsMultiProvider`, ver `repository.ts::runWithRowSavepoint`)
   * — una cita "venenosa" ya NO revierte los recordatorios de las demás citas de
   * la MISMA organización que este loop ya había encolado con éxito antes de
   * llegar a ella. El caller (`apps/api/.../citas/reminders.ts`) combina esto con
   * `failedAppointmentErrors` (mismo índice) en `{appointment_id, error}` y lo
   * vuelca a `failures[]`, que dispara `CronPartialFailureError` — nunca en
   * silencio (mismo patrón que `google-calendar-sync.ts`/PR #163). */
  failedAppointmentIds: string[];
  /** Mensaje de error real de Postgres para cada id de `failedAppointmentIds`,
   * en el MISMO índice/orden — ambos arreglos se llenan juntos en el único
   * `catch` de abajo, nunca por separado, así que no pueden desincronizarse. */
  failedAppointmentErrors: string[];
}

/**
 * Recordatorio 24h antes: WhatsApp (con botones Confirmar/Cancelar/Reagendar) +
 * correo (Fase 6 §3, appointment-email-notifications.ts) — dos canales
 * INDEPENDIENTES, cada uno con su propio dedupe_key en `citas.messaging_outbox`
 * (`reminder-24h:${appointmentId}` en ambos, pero `channel` distinto: 'whatsapp'
 * vs 'email'), así que un negocio sin WhatsApp configurado no se queda sin
 * ningún recordatorio solo porque `resolveActiveWhatsAppPhoneNumberId` no
 * resuelve nada. Un tenant con datos raros nunca debe tumbar la corrida de los
 * demás — eso lo maneja el caller (la ruta interna, ver §5.3), que captura por
 * organización y sigue.
 *
 * Hallazgo de auditoría (rubro 17, comunicación transaccional, severidad MEDIA,
 * "soporte de plantillas HSM de WhatsApp ausente"): este `enqueueMessagingOutbox`
 * de abajo es PROACTIVO (el negocio inicia la conversación 24h antes, sin ninguna
 * garantía de un mensaje entrante reciente de este cliente) — cae FUERA de la
 * ventana de 24h de Meta, que exige una plantilla (HSM) pre-aprobada para
 * cualquier mensaje business-initiated fuera de esa ventana.
 * `MetaGraphWhatsAppClient` (`@atiende/whatsapp-gateway`) todavía no sabe enviar
 * `type: "template"` — ver el comentario de cabecera de
 * `packages/whatsapp-gateway/src/providers/meta-graph-client.ts` (o el README de
 * ese paquete) para el gap completo y por qué no se resuelve aquí (requiere una
 * plantilla real aprobada por Meta, credencial/proceso que este entorno no tiene).
 * Comportamiento actual honesto: Meta real rechaza este envío con un 4xx de
 * negocio, el dispatcher lo marca `dead` (nunca `sent` fingido) — el recordatorio
 * simplemente no le llega al cliente por WhatsApp hasta que exista esa plantilla.
 */
export async function runConfirmacionCitaCore(repo: CitasRepository, organizationId: string, now: Date = new Date()): Promise<ConfirmacionCitaSummary> {
  const summary: ConfirmacionCitaSummary = { organizationId, processed: 0, sent: 0, sentEmail: 0, skippedNoPhone: 0, skippedNoWhatsappConfig: false, failedAppointmentIds: [], failedAppointmentErrors: [] };

  const windowStart = new Date(now.getTime() + REMINDER_HORIZON_MS - REMINDER_WINDOW_TOLERANCE_MS);
  const windowEnd = new Date(now.getTime() + REMINDER_HORIZON_MS + REMINDER_WINDOW_TOLERANCE_MS);

  const pending = await repo.loadAppointmentsPendingReminder(organizationId, windowStart.toISOString(), windowEnd.toISOString());
  summary.processed = pending.length;
  if (pending.length === 0) return summary;

  // f2-citas-whatsapp-config-sesion-sistema — el ÚNICO caller real de
  // `runConfirmacionCitaCore` (`apps/api/.../citas/reminders.ts`, cron interno
  // `/internal/citas/confirmacion-cita`) abre `deps.engine.withAppSession({
  // userId: null }, ...)` -- SIEMPRE sesión de SISTEMA. `citas.whatsapp_config`
  // (003_waitlist_and_rate_limit.sql) solo tiene policy de RLS de STAFF
  // (membership) -- exactamente el mismo gap ya cerrado para
  // `runOptimizadorCore`/`runListaEsperaCore` (ver
  // `repository.ts::resolveActiveWhatsAppPhoneNumberIdAsSystem` y la migración
  // `021_whatsapp_config_sistema_lectura.sql`), documentado ahí mismo como
  // "preexistente, fuera de alcance de esa tarea" -- este era ese gap: la
  // variante de STAFF (`resolveActiveWhatsAppPhoneNumberId`) SIEMPRE devolvía
  // 0 filas bajo `auth.uid()` null, así que el recordatorio de 24h por
  // WhatsApp NUNCA salía contra Postgres real, con o sin la migración 021 ya
  // aplicada (invisible en `InMemoryCitasRepository`, que no tiene RLS que
  // reproducir).
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId);
  summary.skippedNoWhatsappConfig = !phoneNumberId;

  // Timezone efectivo por proveedor: una sucursal puede tener su propio huso — sin
  // esto, un negocio con sucursal en otro estado seguiría mostrando la hora
  // equivocada aun con "el fix de timezone" a medias. Cacheado por providerId
  // dentro de esta corrida para no repetir la resolución por cada cita.
  const timeZoneByProvider = new Map<string, string>();

  for (const apt of pending) {
    // Auditoría a3 (hallazgo confirmado #7) — TODO el cuerpo de esta iteración
    // (incluida la rama de WhatsApp, que antes no tenía ningún try/catch) corre
    // bajo su propio SAVEPOINT: un error REAL de Postgres en esta cita (deadlock,
    // timeout, o cualquier best-effort interno que en el futuro deje de tragar su
    // propio error) queda aislado — `ROLLBACK TO SAVEPOINT` deja la transacción
    // de la organización utilizable para la SIGUIENTE cita del loop, en vez de
    // abortarla completa (25P02) y perder en silencio los recordatorios ya
    // encolados de las citas anteriores de esta misma corrida.
    try {
      // Re-revisión a3 (no bloqueante #5) — contadores LOCALES dentro del
      // SAVEPOINT: si `markReminderSent` (o cualquier paso posterior a
      // `enqueueMessagingOutbox`/`tryEnqueueAppointmentEmail`) falla, `catch` de
      // abajo corre DESPUÉS de que `runWithRowSavepoint` ya hizo
      // `ROLLBACK TO SAVEPOINT` -- el outbox de esta cita queda deshecho, pero
      // antes estos contadores YA se habían sumado directo a `summary` dentro del
      // callback, así que el resumen reportaba `sent`/`sentEmail` de algo que en
      // realidad se revirtió. Solo se vuelcan a `summary` una vez, tras un
      // `await` exitoso (sin throw) de todo el bloque.
      let sentLocal = 0;
      let sentEmailLocal = 0;
      let skippedNoPhoneLocal = 0;

      await repo.runWithRowSavepoint(async () => {
        let remindedSomehow = false;

        if (phoneNumberId) {
          if (!apt.customerPhone) {
            skippedNoPhoneLocal += 1;
          } else {
            let timeZone = timeZoneByProvider.get(apt.providerId);
            if (!timeZone) {
              const provider = await repo.findProvider(organizationId, apt.providerId);
              timeZone = await repo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
              timeZoneByProvider.set(apt.providerId, timeZone);
            }

            const time = new Intl.DateTimeFormat("es-MX", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(apt.startsAt));
            const greeting = apt.customerName ? `Hola ${apt.customerName}, ` : "Hola, ";

            await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "appointment.reminder_24h", `reminder-24h:${apt.appointmentId}`, {
              to: apt.customerPhone,
              phone_number_id: phoneNumberId,
              body: `${greeting}le recordamos su cita mañana a las ${time}. ¿Puede confirmar?`,
              buttons: ["Confirmar", "Cancelar", "Reagendar"],
            });
            sentLocal += 1;
            remindedSomehow = true;
          }
        }

        // Fase 6 §3 — best-effort real (nunca lanza): sin correo en archivo del
        // cliente simplemente no se encola nada (ver enqueueAppointmentEmailCore),
        // nunca cuenta como error.
        const emailResult = await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.reminder_24h", apt.appointmentId);
        if (emailResult?.enqueued) {
          sentEmailLocal += 1;
          remindedSomehow = true;
        }

        // Marca reminder24hSentAt SOLO después de encolar exitosamente en AL MENOS un
        // canal real — evita reenvío en la siguiente corrida del cron dentro de la
        // misma ventana de tolerancia. Si ningún canal aplicó (sin WhatsApp
        // configurado Y sin correo en archivo), se deja sin marcar a propósito: el
        // dedupe_key de messaging_outbox ya evita duplicados si algo sí llegó a
        // encolarse, y una cita sin ningún dato de contacto real simplemente sigue
        // "pendiente" hasta que el cliente deje un correo o el negocio conecte
        // WhatsApp — no es un estado silencioso, el cron la vuelve a intentar.
        if (remindedSomehow) {
          await repo.markReminderSent(apt.appointmentId, now.toISOString());
        }
      });

      // Solo se llega aquí si el bloque completo (incluido `markReminderSent`) NO
      // lanzó -- nada de lo contado arriba fue revertido por un SAVEPOINT.
      summary.sent += sentLocal;
      summary.sentEmail += sentEmailLocal;
      summary.skippedNoPhone += skippedNoPhoneLocal;
    } catch (err) {
      console.error(`reminders: la cita ${apt.appointmentId} falló con un error real de Postgres, aislada por SAVEPOINT -- se sigue con las demás citas de la organización:`, err);
      summary.failedAppointmentIds.push(apt.appointmentId);
      summary.failedAppointmentErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return summary;
}

export interface OptimizadorResult {
  readonly matched: boolean;
  readonly waitlistId?: string;
  readonly customerPhone?: string;
  readonly reason?: "no_match" | "no_whatsapp_config" | "lost_race";
}

function matchesWaitlistPreferences(row: WaitlistCandidateRow, providerId: string, serviceId: string | undefined, slotDateStr: string, window: TimeWindow): boolean {
  if (row.providerId !== null && row.providerId !== providerId) return false;
  if (serviceId && row.serviceId !== null && row.serviceId !== serviceId) return false;
  if (row.preferredDateFrom !== null && row.preferredDateFrom > slotDateStr) return false;
  if (row.preferredDateTo !== null && row.preferredDateTo < slotDateStr) return false;
  if (row.preferredTimeWindow !== "any" && row.preferredTimeWindow !== window) return false;
  return true;
}

/**
 * Se dispara cuando una cita se cancela/libera un hueco real. Busca en la lista de
 * espera con match FIFO (el que pidió primero, gana primero) + preferencias reales
 * de fecha/franja/servicio/proveedor, y notifica SOLO al primero que matchea.
 *
 * Mismo hallazgo de auditoría (rubro 17, "soporte de plantillas HSM ausente") que
 * `runConfirmacionCitaCore` de arriba: la oferta de hueco es proactiva, fuera de la
 * ventana de 24h de Meta, y `MetaGraphWhatsAppClient` todavía no sabe enviar
 * `type: "template"` — ver el comentario de ese hallazgo (arriba) para el detalle
 * completo.
 */
export async function runOptimizadorCore(repo: CitasRepository, organizationId: string, timeZone: string, event: { readonly providerId: string; readonly serviceId?: string; readonly startsAt: string }): Promise<OptimizadorResult> {
  const slotDate = new Date(event.startsAt);
  const slotDateStr = slotDate.toISOString().slice(0, 10);
  const window = timeWindowFor(slotDate, timeZone);

  // f2-citas-lista-de-espera, hallazgo (A) — TODOS los callers reales de
  // runOptimizadorCore (cancelar/reagendar/reasignar del agente de voz/
  // WhatsApp, y el post-commit `runCitasWaitlistNotifyAfterCancel` del cancelar
  // de staff) corren en sesión de SISTEMA; `loadLiveWaitlistCandidates` (plain
  // SELECT, RLS de staff) siempre devolvía 0 filas ahí -- ver el comentario
  // largo de `repository.ts::loadLiveWaitlistCandidatesAsSystem`.
  const candidates = await repo.loadLiveWaitlistCandidatesAsSystem(organizationId);
  // Regla dura de compatibilidad (#5) — orden TOTAL: `sortWaitlistByPosition`
  // (abajo) ya desempata por `id` cuando dos candidatos comparten el mismo
  // `createdAt` (mismo milisegundo) -- el `.sort` ad-hoc que este archivo tenía
  // antes NO desempataba, así que "el que pidió primero, gana primero" podía
  // depender del orden, no garantizado por SQL, en que Postgres devolviera las
  // filas empatadas.
  const matches = sortWaitlistByPosition(candidates.filter((row) => matchesWaitlistPreferences(row, event.providerId, event.serviceId, slotDateStr, window)));

  if (matches.length === 0) return { matched: false, reason: "no_match" };

  // Corrección post-revisión de f2-citas-lista-de-espera — MISMO gap de RLS
  // que arriba (hallazgo A), un paso más adelante: `resolveActiveWhatsAppPhoneNumberId`
  // (SELECT plano, RLS de staff) también devolvía 0 filas en sesión de
  // sistema, incluso con la migración 020 ya aplicada -- ningún aviso podía
  // salir nunca. Ver `repository.ts::resolveActiveWhatsAppPhoneNumberIdAsSystem`
  // y la migración 021_whatsapp_config_sistema_lectura.sql.
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId);
  if (!phoneNumberId) return { matched: false, reason: "no_whatsapp_config" };

  const winner = matches[0]!;
  const claimed = await repo.claimWaitlistNotificationSlot(winner.id, MAX_WAITLIST_NOTIFICATIONS);
  if (!claimed) {
    // Otro proceso ya lo notificó (o ya llegó al tope) justo antes.
    return { matched: false, reason: "lost_race" };
  }

  const name = winner.customerName ? ` ${winner.customerName}` : "";
  await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "waitlist.slot_offered", `waitlist-offer:${winner.id}:${event.startsAt}`, {
    to: winner.customerPhone,
    phone_number_id: phoneNumberId,
    body: `¡Buenas noticias${name}! Se liberó un espacio que coincide con lo que buscaba. Responda "Sí" para que se lo agendemos, o "No" si ya no le interesa.`,
  });

  return { matched: true, waitlistId: winner.id, customerPhone: winner.customerPhone };
}

/** Envoltura best-effort — la cita YA se canceló/reagendó de verdad; que la lista de
 * espera falle o no tenga a nadie que matchee NUNCA debe convertirse en un error
 * para el cliente que está cancelando/reagendando.
 *
 * Arreglo de fondo (auditoría a3, hallazgo confirmado #1) — `runOptimizadorCore`
 * corre `repo.claimWaitlistNotificationSlot` (`citas.claim_waitlist_notification_slot`),
 * cuyo guard SQL rechaza con 42501 CUALQUIER sesión con `auth.uid()` no nulo ("solo
 * para la sesión de sistema"; sin la migración que le da GRANT a `authenticated`,
 * `authenticated` ni siquiera tiene EXECUTE — mismo código 42501 de todos modos).
 * ANTES de este fix, ese catch tragaba el error SIN ningún SAVEPOINT: en sesión de
 * STAFF (`auth.uid()` real) dejaba la transacción de negocio COMPLETA abortada
 * (25P02) — la cancelación/reagendo YA exitoso se revertía en silencio con un
 * `commit;` que Postgres responde como "ROLLBACK" (ver
 * `packages/db/src/managed-postgres-engine.ts`). `repo.runWithRowSavepoint` (mismo
 * helper que ya usa `syncPendingAppointmentsMultiProvider`, vía
 * `runWithSavepointFallback` de `@atiende/db`) hace `SAVEPOINT` antes del intento y
 * `ROLLBACK TO SAVEPOINT` en el catch — la transacción del caller queda utilizable
 * de nuevo pase lo que pase aquí dentro. El SAVEPOINT por sí solo NO logra que el
 * aviso a la lista de espera salga de verdad en sesión de staff (el guard sigue
 * negando el claim ahí) — eso lo resuelve el caller moviendo esta llamada a una
 * sesión de SISTEMA post-commit, ver
 * `apps/api/.../citas/appointments-lifecycle.ts::runCitasWaitlistNotifyAfterCancel`. */
export async function tryNotifyWaitlistOfFreedSlot(repo: CitasRepository, organizationId: string, timeZone: string, event: { readonly providerId: string; readonly serviceId?: string; readonly startsAt: string }): Promise<OptimizadorResult | null> {
  try {
    return await repo.runWithRowSavepoint(() => runOptimizadorCore(repo, organizationId, timeZone, event));
  } catch (err) {
    console.error("reminders: runOptimizadorCore best-effort call failed:", err);
    return null;
  }
}

/**
 * Aviso best-effort tras reagendar: reagendar SIEMPRE conserva el mismo proveedor/
 * servicio, solo cambia startsAt — así que el hueco que queda libre es el horario
 * VIEJO de esta misma cita (previousStartsAt), nunca el nuevo. Si el horario "nuevo"
 * resulta ser idéntico al viejo (reagendar a la misma hora, un no-op real), no se
 * liberó nada — se omite el aviso.
 */
export async function notifyWaitlistAfterReschedule(
  repo: CitasRepository,
  organizationId: string,
  timeZone: string,
  params: { readonly providerId: string; readonly serviceId: string; readonly previousStartsAt: string; readonly newStartsAt: string },
): Promise<OptimizadorResult | null> {
  if (params.previousStartsAt === params.newStartsAt) return null;
  return tryNotifyWaitlistOfFreedSlot(repo, organizationId, timeZone, { providerId: params.providerId, serviceId: params.serviceId, startsAt: params.previousStartsAt });
}

// ============================================================================
// Agente "Lista de espera (simple)" — port REAL de
// citas-reservaciones/supabase/functions/_shared/agenda-agents-core.ts::runListaEsperaCore.
//
// A diferencia de runOptimizadorCore (arriba: match fino FIFO+preferencias de
// fecha/franja/servicio/proveedor, dispara SOLO automáticamente al cancelar/
// reagendar, notifica a UN único ganador), este es el broadcast MANUAL que el
// staff dispara desde el panel cuando libera un espacio "a mano" (ej. amplía su
// propio horario ese día) — un caso que nunca pasa por cancelar-cita/reagendar-cita
// y por lo tanto nunca dispara al Optimizador automáticamente. Sin matchear
// fecha/franja preferida, solo (opcionalmente) proveedor/servicio: notifica, EN
// ORDEN DE POSICIÓN DE LA LISTA (el que se anotó primero, primero — mismo
// criterio FIFO que runOptimizadorCore), a los primeros `limit` candidatos
// vivos, respetando el mismo tope real de `MAX_WAITLIST_NOTIFICATIONS` por
// cliente vía `claimWaitlistNotificationSlot` (misma RPC atómica, nunca una
// condición de carrera leída-luego-escrita).
// ============================================================================

/** Cuántos clientes notifica `runListaEsperaCore` por corrida si el caller no pide
 * un número explícito. */
export const DEFAULT_LISTA_ESPERA_LIMIT = 5;

/** Límite razonable de destinatarios por corrida — un broadcast manual no debe
 * poder vaciar de un jalón toda la lista de espera de un negocio grande ni
 * agotar el rate-limit real de WhatsApp Business por un solo clic del staff. El
 * caller (la ruta HTTP) recorta cualquier valor pedido a este techo. */
export const MAX_LISTA_ESPERA_LIMIT = 20;

export interface ListaEsperaEvent {
  /** Filtra a solo quienes pidieron este proveedor (o no expresaron preferencia). */
  readonly providerId?: string;
  /** Filtra a solo quienes pidieron este servicio (o no expresaron preferencia). */
  readonly serviceId?: string;
}

/** Orden FIFO real de "posición en la lista de espera": el que se anotó primero
 * va primero. Exportado para que el panel (GET de solo-lectura) muestre la
 * lista en el MISMO orden en que `runListaEsperaCore` de verdad notifica, en
 * vez de reinventar el criterio de orden en la capa HTTP. */
export function sortWaitlistByPosition(rows: readonly WaitlistCandidateRow[]): WaitlistCandidateRow[] {
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface ListaEsperaSummary {
  /** A cuántos clientes se les encoló realmente un mensaje en esta corrida. */
  notified: number;
  /** Cuántos candidatos vivos (activos, no expirados, bajo el tope de 3
   * notificaciones) quedaron tras filtrar por proveedor/servicio y recortar a
   * `limit` — puede ser mayor que `notified` si alguno perdió la carrera por el
   * cupo de notificación justo en esta corrida (`claimWaitlistNotificationSlot`
   * devolvió `false`, ej. otra corrida concurrente ya lo reclamó). */
  candidatesConsidered: number;
  skippedNoWhatsappConfig: boolean;
  /** f2-citas-whatsapp-config-sesion-sistema (hallazgo adicional) — ids de
   * candidatos cuyo `claimWaitlistNotificationSlot`/`enqueueMessagingOutbox`
   * lanzó un error REAL de Postgres en esta corrida, aislado por
   * `repo.runWithRowSavepoint` (mismo mecanismo que
   * `runConfirmacionCitaCore` de arriba) -- nunca vacío en silencio: el
   * caller (`runCitasListaEsperaBroadcastAfterCommit`, `admin.ts`) solo
   * registra esto en el log del best-effort (nada le llega al staff todavía,
   * ver README de este vertical), pero el arreglo real es que un candidato
   * "venenoso" a mitad de la corrida ya NO revierte los candidatos ANTERIORES
   * de esta misma corrida que sí se notificaron con éxito. */
  failedWaitlistIds: string[];
}

/**
 * Broadcast manual real: el staff decide "notificar a la lista de espera de este
 * horario/servicio liberado" desde el panel. Notifica, en orden FIFO de
 * posición en la lista, a los primeros `limit` candidatos vivos que matcheen el
 * filtro opcional de proveedor/servicio — SIN matchear fecha ni franja horaria
 * preferida (a diferencia de runOptimizadorCore). Nunca lanza por un candidato
 * individual que ya llegó a su tope: simplemente se salta y sigue con el
 * siguiente en la fila.
 *
 * Mismo hallazgo de auditoría (rubro 17, "soporte de plantillas HSM ausente") que
 * `runConfirmacionCitaCore`/`runOptimizadorCore` de arriba — proactivo, fuera de
 * ventana de 24h de Meta, sin plantilla HSM disponible en este entorno.
 */
/** Filtro (proveedor/servicio opcionales) + orden FIFO total (`sortWaitlistByPosition`)
 * + recorte a `limit` -- exactamente los mismos 3 pasos que decidían quién entra al
 * broadcast ANTES de reclamar ningún slot. Compartido entre `runListaEsperaCore`
 * (efecto real, sesión de sistema) y `previewListaEspera` (solo lectura, sesión de
 * staff) para que nunca diverjan qué cuenta como "candidato considerado". */
function filterAndRankWaitlistForBroadcast(candidates: readonly WaitlistCandidateRow[], event: ListaEsperaEvent, effectiveLimit: number): readonly WaitlistCandidateRow[] {
  return sortWaitlistByPosition(
    candidates
      .filter((row) => !event.providerId || row.providerId === null || row.providerId === event.providerId)
      .filter((row) => !event.serviceId || row.serviceId === null || row.serviceId === event.serviceId),
  ).slice(0, effectiveLimit);
}

function clampListaEsperaLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_LISTA_ESPERA_LIMIT);
}

export async function runListaEsperaCore(
  repo: CitasRepository,
  organizationId: string,
  event: ListaEsperaEvent = {},
  limit: number = DEFAULT_LISTA_ESPERA_LIMIT,
): Promise<ListaEsperaSummary> {
  const effectiveLimit = clampListaEsperaLimit(limit);

  // f2-citas-lista-de-espera, hallazgo (B) — el único caller real de
  // `runListaEsperaCore` (POST .../waitlist/broadcast) mueve el efecto a sesión
  // de SISTEMA post-commit desde esta tarea (ver
  // `apps/api/.../citas/admin.ts::runCitasListaEsperaBroadcastAfterCommit`) --
  // `claimWaitlistNotificationSlot` de abajo ya exigía sesión de sistema desde
  // la migración 015; esta lectura ahora también, por el mismo motivo (A) que
  // `runOptimizadorCore` (ver `repository.ts::loadLiveWaitlistCandidatesAsSystem`).
  const candidates = await repo.loadLiveWaitlistCandidatesAsSystem(organizationId);
  const filtered = filterAndRankWaitlistForBroadcast(candidates, event, effectiveLimit);

  const summary: ListaEsperaSummary = { notified: 0, candidatesConsidered: filtered.length, skippedNoWhatsappConfig: false, failedWaitlistIds: [] };
  if (filtered.length === 0) return summary;

  // Corrección post-revisión de f2-citas-lista-de-espera — mismo motivo que en
  // `runOptimizadorCore` de arriba: este caller corre en sesión de sistema
  // (post-commit, ver `admin.ts::runCitasListaEsperaBroadcastAfterCommit`),
  // así que necesita la variante de sistema, nunca la de staff.
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId);
  if (!phoneNumberId) {
    summary.skippedNoWhatsappConfig = true;
    return summary;
  }

  const organization = await repo.findOrganizationById(organizationId);
  const negocio = organization ? ` en ${organization.name}` : "";
  // Una sola corrida disparada por el staff en el mismo minuto real comparte
  // dedupe_key por candidato — dos clics accidentales dentro del mismo minuto no
  // duplican el mensaje (mismo espíritu que reminder-24h), pero un negocio que
  // vuelve a disparar el broadcast pasado ese minuto (otro espacio liberado más
  // tarde) sí puede volver a notificar al mismo candidato hasta su tope real.
  const runToken = new Date().toISOString().slice(0, 16);

  // f2-citas-whatsapp-config-sesion-sistema (hallazgo adicional) — ANTES, un
  // error real de Postgres en CUALQUIER candidato de esta lista (claim o
  // enqueue) dejaba la sesión de SISTEMA completa (post-commit,
  // `runCitasListaEsperaBroadcastAfterCommit`) abortada (25P02): sin
  // SAVEPOINT, el `catch` externo de ese caller solo evita que el error
  // escape (best-effort), pero para entonces Postgres YA revirtió, con el
  // `COMMIT` implícito de `withAppSession`, TODOS los claims/enqueues de los
  // candidatos ANTERIORES de esta misma corrida que sí habían tenido éxito —
  // exactamente el mismo defecto, mismo mecanismo, que ya se corrigió para
  // `runConfirmacionCitaCore` (auditoría a3, hallazgo confirmado #7) y para
  // el loop de reconciliación de calendario
  // (`syncPendingAppointmentsMultiProvider`). `repo.runWithRowSavepoint`
  // aísla cada candidato con su propio SAVEPOINT — un candidato "venenoso" ya
  // no se lleva consigo a los que ya se notificaron con éxito antes que él en
  // la misma corrida.
  for (const row of filtered) {
    try {
      let claimedLocal = false;
      await repo.runWithRowSavepoint(async () => {
        const claimed = await repo.claimWaitlistNotificationSlot(row.id, MAX_WAITLIST_NOTIFICATIONS);
        if (!claimed) return; // ya en su tope o ya no 'active' — se salta, nunca tumba la corrida completa

        const name = row.customerName ? ` ${row.customerName}` : "";
        await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "waitlist.slot_available_broadcast", `waitlist-broadcast:${row.id}:${runToken}`, {
          to: row.customerPhone,
          phone_number_id: phoneNumberId,
          body: `¡Buenas noticias${name}! Se acaba de liberar un espacio${negocio}. Responda "Sí" para que se lo agendemos, o "No" si ya no le interesa.`,
        });
        claimedLocal = true;
      });
      // Solo se cuenta como notificado tras un `runWithRowSavepoint` que NO
      // lanzó -- mismo criterio que `sentLocal` en `runConfirmacionCitaCore`
      // (nunca contar algo que un SAVEPOINT pudo haber revertido).
      if (claimedLocal) summary.notified += 1;
    } catch (err) {
      console.error(`reminders: runListaEsperaCore — el candidato ${row.id} falló con un error real de Postgres, aislado por SAVEPOINT -- se sigue con los demás candidatos de esta corrida:`, err);
      summary.failedWaitlistIds.push(row.id);
    }
  }

  return summary;
}

export interface ListaEsperaPreview {
  /** Corrección bloqueante de la ronda 2 de revisión del PR #180 — `false`
   * significa que la base a la que está conectado este proceso todavía NO
   * tiene aplicadas las migraciones 020/021 (probe de catálogo, ver
   * `repository.ts::areSystemWaitlistFunctionsAvailable`): el post-commit en
   * sesión de sistema (`runCitasListaEsperaBroadcastAfterCommit`) degradaría
   * en silencio a `[]`/`null` por SQLSTATE 42883 y NO encolaría ningún aviso,
   * así que `candidatesConsidered`/`skippedNoWhatsappConfig` NO se calculan
   * (irían con un conteo real de candidatos que el broadcast nunca podría
   * notificar de verdad -- exactamente el éxito falso que la ronda 2 señaló).
   * El caller (`admin.ts`) debe responder `queued:false` en este caso, nunca
   * encolar el postCommitTask. */
  readonly available: boolean;
  /** Mismo criterio EXACTO que `ListaEsperaSummary.candidatesConsidered` --
   * cuántos candidatos vivos matchean el filtro y caben en `limit`, calculado
   * con la MISMA `filterAndRankWaitlistForBroadcast` que usa el efecto real.
   * Solo tiene sentido cuando `available` es `true`. */
  readonly candidatesConsidered: number;
  readonly skippedNoWhatsappConfig: boolean;
}

/**
 * f2-citas-lista-de-espera, hallazgo (B) — vista previa de SOLO LECTURA, segura
 * de llamar en sesión de STAFF (nunca reclama un slot vía
 * `claimWaitlistNotificationSlot` -- solo-sistema desde la migración 015 -- ni
 * encola ningún mensaje): responde con un conteo REAL de inmediato
 * (`candidatesConsidered`/`skippedNoWhatsappConfig`) desde la ruta HTTP,
 * mientras el efecto de verdad (`runListaEsperaCore`, sesión de SISTEMA)
 * corre POST-COMMIT (ver `admin.ts::runCitasListaEsperaBroadcastAfterCommit`)
 * -- el `notified` real solo se sabe DESPUÉS de esa tarea, así que la
 * respuesta HTTP síncrona nunca lo reporta (sería una cifra inventada antes
 * de que el efecto exista). Usa `loadLiveWaitlistCandidates` (RLS real de
 * staff, funciona hoy sin ninguna migración) -- NUNCA la versión de sistema.
 *
 * Corrección bloqueante de la ronda 2 — antes de calcular ese conteo,
 * `areSystemWaitlistFunctionsAvailable()` (probe de catálogo, sesión de
 * staff, no ejecuta ninguna función) confirma que la base YA tiene 020/021
 * aplicadas. Sin este probe, con la base sin migrar (el estado REAL de
 * producción en el instante del merge) esta función veía candidatos y
 * `whatsapp_config` reales (las variantes de staff funcionan sin ninguna
 * migración) y respondía un conteo que el post-commit en sesión de sistema
 * nunca podría convertir en un aviso de verdad.
 */
export async function previewListaEspera(repo: CitasRepository, organizationId: string, event: ListaEsperaEvent = {}, limit: number = DEFAULT_LISTA_ESPERA_LIMIT): Promise<ListaEsperaPreview> {
  const functionsAvailable = await repo.areSystemWaitlistFunctionsAvailable();
  if (!functionsAvailable) return { available: false, candidatesConsidered: 0, skippedNoWhatsappConfig: false };

  const effectiveLimit = clampListaEsperaLimit(limit);
  const candidates = await repo.loadLiveWaitlistCandidates(organizationId);
  const filtered = filterAndRankWaitlistForBroadcast(candidates, event, effectiveLimit);
  if (filtered.length === 0) return { available: true, candidatesConsidered: 0, skippedNoWhatsappConfig: false };

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
  return { available: true, candidatesConsidered: filtered.length, skippedNoWhatsappConfig: !phoneNumberId };
}
