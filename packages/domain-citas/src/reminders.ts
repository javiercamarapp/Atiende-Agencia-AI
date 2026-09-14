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
 */
export async function runConfirmacionCitaCore(repo: CitasRepository, organizationId: string, now: Date = new Date()): Promise<ConfirmacionCitaSummary> {
  const summary: ConfirmacionCitaSummary = { organizationId, processed: 0, sent: 0, sentEmail: 0, skippedNoPhone: 0, skippedNoWhatsappConfig: false };

  const windowStart = new Date(now.getTime() + REMINDER_HORIZON_MS - REMINDER_WINDOW_TOLERANCE_MS);
  const windowEnd = new Date(now.getTime() + REMINDER_HORIZON_MS + REMINDER_WINDOW_TOLERANCE_MS);

  const pending = await repo.loadAppointmentsPendingReminder(organizationId, windowStart.toISOString(), windowEnd.toISOString());
  summary.processed = pending.length;
  if (pending.length === 0) return summary;

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
  summary.skippedNoWhatsappConfig = !phoneNumberId;

  // Timezone efectivo por proveedor: una sucursal puede tener su propio huso — sin
  // esto, un negocio con sucursal en otro estado seguiría mostrando la hora
  // equivocada aun con "el fix de timezone" a medias. Cacheado por providerId
  // dentro de esta corrida para no repetir la resolución por cada cita.
  const timeZoneByProvider = new Map<string, string>();

  for (const apt of pending) {
    let remindedSomehow = false;

    if (phoneNumberId) {
      if (!apt.customerPhone) {
        summary.skippedNoPhone += 1;
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
        summary.sent += 1;
        remindedSomehow = true;
      }
    }

    // Fase 6 §3 — best-effort real (nunca lanza): sin correo en archivo del
    // cliente simplemente no se encola nada (ver enqueueAppointmentEmailCore),
    // nunca cuenta como error.
    const emailResult = await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.reminder_24h", apt.appointmentId);
    if (emailResult?.enqueued) {
      summary.sentEmail += 1;
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
 */
export async function runOptimizadorCore(repo: CitasRepository, organizationId: string, timeZone: string, event: { readonly providerId: string; readonly serviceId?: string; readonly startsAt: string }): Promise<OptimizadorResult> {
  const slotDate = new Date(event.startsAt);
  const slotDateStr = slotDate.toISOString().slice(0, 10);
  const window = timeWindowFor(slotDate, timeZone);

  const candidates = await repo.loadLiveWaitlistCandidates(organizationId);
  const matches = candidates.filter((row) => matchesWaitlistPreferences(row, event.providerId, event.serviceId, slotDateStr, window)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  if (matches.length === 0) return { matched: false, reason: "no_match" };

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
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
 * para el cliente que está cancelando/reagendando. */
export async function tryNotifyWaitlistOfFreedSlot(repo: CitasRepository, organizationId: string, timeZone: string, event: { readonly providerId: string; readonly serviceId?: string; readonly startsAt: string }): Promise<OptimizadorResult | null> {
  try {
    return await runOptimizadorCore(repo, organizationId, timeZone, event);
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
}

/**
 * Broadcast manual real: el staff decide "notificar a la lista de espera de este
 * horario/servicio liberado" desde el panel. Notifica, en orden FIFO de
 * posición en la lista, a los primeros `limit` candidatos vivos que matcheen el
 * filtro opcional de proveedor/servicio — SIN matchear fecha ni franja horaria
 * preferida (a diferencia de runOptimizadorCore). Nunca lanza por un candidato
 * individual que ya llegó a su tope: simplemente se salta y sigue con el
 * siguiente en la fila.
 */
export async function runListaEsperaCore(
  repo: CitasRepository,
  organizationId: string,
  event: ListaEsperaEvent = {},
  limit: number = DEFAULT_LISTA_ESPERA_LIMIT,
): Promise<ListaEsperaSummary> {
  const effectiveLimit = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_LISTA_ESPERA_LIMIT);

  const candidates = await repo.loadLiveWaitlistCandidates(organizationId);
  const filtered = sortWaitlistByPosition(
    candidates
      .filter((row) => !event.providerId || row.providerId === null || row.providerId === event.providerId)
      .filter((row) => !event.serviceId || row.serviceId === null || row.serviceId === event.serviceId),
  ).slice(0, effectiveLimit);

  const summary: ListaEsperaSummary = { notified: 0, candidatesConsidered: filtered.length, skippedNoWhatsappConfig: false };
  if (filtered.length === 0) return summary;

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
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

  for (const row of filtered) {
    const claimed = await repo.claimWaitlistNotificationSlot(row.id, MAX_WAITLIST_NOTIFICATIONS);
    if (!claimed) continue; // ya en su tope o ya no 'active' — se salta, nunca tumba la corrida completa

    const name = row.customerName ? ` ${row.customerName}` : "";
    await repo.enqueueMessagingOutbox(organizationId, "whatsapp", "waitlist.slot_available_broadcast", `waitlist-broadcast:${row.id}:${runToken}`, {
      to: row.customerPhone,
      phone_number_id: phoneNumberId,
      body: `¡Buenas noticias${name}! Se acaba de liberar un espacio${negocio}. Responda "Sí" para que se lo agendemos, o "No" si ya no le interesa.`,
    });
    summary.notified += 1;
  }

  return summary;
}
