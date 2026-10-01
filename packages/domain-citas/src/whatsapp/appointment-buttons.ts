// C-01 -- botones interactivos de WhatsApp del recordatorio 24h (Confirmar / Cancelar /
// Reagendar). Antes el recordatorio mandaba los 3 botones pero el webhook solo
// procesaba `text.body`, así que el toque del cliente se DESCARTABA. Aquí vive todo
// lo determinista de esa respuesta: el formato del id del botón (atado a UNA cita), su
// parseo estricto y la resolución de cada acción contra el dominio.
//
// Principios:
//   * Determinista, sin LLM: confirmar/cancelar son acciones de un toque; no se
//     gasta un turno del modelo (ni se arriesga que "Cancelar" lo capte el fast-path
//     ARCO por el verbo). Reagendar SÍ pasa al agente (necesita conversar un horario),
//     con un texto sintetizado que nombra la cita.
//   * Titularidad: el id del botón lo pone el servidor al enviar el recordatorio, pero
//     el toque llega por un webhook donde el único dato autenticado es el TELÉFONO del
//     remitente (HMAC de Meta). La cita debe pertenecer a ESE teléfono en ESA
//     organización; cualquier otra combinación responde igual, sin revelar si la cita
//     existe.
//   * Idempotente / anti-replay: Meta reintenta webhooks (lo cubre el dedupe por id de
//     mensaje de `handleInboundWhatsAppMessage`) y el cliente puede volver a tocar un
//     botón viejo (mensaje nuevo con id distinto): por eso cada acción decide por el
//     ESTADO ACTUAL de la cita (ya cancelada, ya confirmada, ya pasó) y responde en
//     consecuencia en vez de repetir el efecto.
//   * Compatible con la base sin migrar: confirmar usa la función de la migración 025
//     (con SAVEPOINT + 42883 -> `unavailable`, ver el repositorio) y responde de forma
//     honesta sin afirmar que confirmó. Cancelar usa `cancel_appointment_idempotent`,
//     que ya existe.
import { cancelAppointment, normalizePhone } from "../appointments.ts";
import { tryEnqueueAppointmentEmail } from "../appointment-email-notifications.ts";
import { AppointmentConflictError, AppointmentNotFoundError } from "../errors.ts";
import { tryNotifyWaitlistOfFreedSlot } from "../reminders.ts";
import type { CitasRepository } from "../repository.ts";
import type { AppointmentRecord } from "../types.ts";
import { parseAppointmentButtonId } from "./appointment-button-ids.ts";
import type { MetaInteractiveReply } from "./channel-config.ts";

export type AppointmentButtonOutcome =
  /** Respuesta final determinista -- el LLM NO corre. */
  | { readonly kind: "reply"; readonly reply: string }
  /** El cliente quiere reagendar: se sustituye el mensaje por un texto que nombra la
   * cita y sigue al agente (que ya tiene `modificar_cita`/`reagendar_cita`). */
  | { readonly kind: "to_agent"; readonly text: string };

const NOT_FOUND_REPLY = "No encontré esa cita a tu nombre. Si quieres agendar, reagendar o cancelar, cuéntame y te ayudo.";

/** "jueves 2 de octubre, 10:00 a. m." en la zona horaria REAL de la cita (nunca la del
 * servidor: una cita a las 22:30 hora de Mérida ya es "mañana" en UTC). */
export function formatAppointmentWhen(startsAtIso: string, timeZone: string): string {
  const date = new Date(startsAtIso);
  const day = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const time = new Intl.DateTimeFormat("es-MX", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return `${day}, ${time}`;
}

async function resolveTimeZone(repo: CitasRepository, organizationId: string, appointment: AppointmentRecord): Promise<string> {
  // SAVEPOINT propio: un error real de Postgres en estas lecturas no debe abortar la
  // transacción compartida del turno (ver comentario de `runWithRowSavepoint`).
  return repo.runWithRowSavepoint(async () => {
    const provider = await repo.findProvider(organizationId, appointment.providerId);
    return repo.findPropertyTimezone(provider?.propertyId ?? appointment.propertyId ?? null, organizationId);
  });
}

/**
 * Resuelve la acción de un botón de recordatorio. Devuelve `null` si el id NO es un
 * botón de cita reconocido (el caller sigue el camino normal de texto). Nunca lanza
 * por estados de negocio (cita ajena, ya cancelada, ya pasada...): los convierte en
 * respuestas; un error real de Postgres sí se propaga (lo contiene el SAVEPOINT de
 * `handleInboundWhatsAppMessage`).
 */
export async function resolveAppointmentButton(
  repo: CitasRepository,
  args: { readonly organizationId: string; readonly phone: string; readonly interactive: MetaInteractiveReply; readonly now?: Date },
): Promise<AppointmentButtonOutcome | null> {
  const parsed = parseAppointmentButtonId(args.interactive.id);
  if (!parsed) return null;
  const { organizationId } = args;
  const now = args.now ?? new Date();
  const normalizedPhone = normalizePhone(args.phone);

  const customer = await repo.findCustomerByPhone(organizationId, normalizedPhone);
  const appointment = customer ? await repo.findAppointmentForOrganization(organizationId, parsed.appointmentId) : null;
  // Titularidad: misma respuesta para "no existe", "es de otra organización" y "es de
  // otro cliente" -- un id adivinado no revela nada.
  if (!customer || !appointment || appointment.customerId !== customer.id) return { kind: "reply", reply: NOT_FOUND_REPLY };

  const timeZone = await resolveTimeZone(repo, organizationId, appointment);
  const when = formatAppointmentWhen(appointment.startsAt, timeZone);
  const isPast = Date.parse(appointment.startsAt) <= now.getTime();

  if (appointment.status === "cancelled") {
    return { kind: "reply", reply: `Esa cita (${when}) ya estaba cancelada. Si quieres agendar otra, escríbeme y te ayudo.` };
  }
  if (appointment.status === "completed" || appointment.status === "no_show" || isPast) {
    return { kind: "reply", reply: `Esa cita (${when}) ya pasó. Si quieres agendar otra, escríbeme y te ayudo.` };
  }

  switch (parsed.action) {
    case "confirmar": {
      const result = await repo.confirmAppointmentByCustomerAsSystem(organizationId, appointment.id, normalizedPhone);
      switch (result.outcome) {
        case "confirmed":
          return { kind: "reply", reply: `¡Listo! Tu cita del ${when} quedó confirmada. Te esperamos.` };
        case "already_confirmed":
          return { kind: "reply", reply: `Tu cita del ${when} ya estaba confirmada. Te esperamos.` };
        case "unavailable":
          // Base sin la migración 025: NUNCA se afirma que quedó confirmada.
          return { kind: "reply", reply: `Recibimos tu respuesta. Por ahora no pude registrar la confirmación automáticamente, pero tu cita del ${when} sigue agendada. Si necesitas cambiarla, escríbeme.` };
        case "conflict_invalid_status":
          return { kind: "reply", reply: `Esa cita (${when}) ya no se puede confirmar. Si quieres agendar otra, escríbeme y te ayudo.` };
        case "not_found":
          return { kind: "reply", reply: NOT_FOUND_REPLY };
      }
      return null;
    }
    case "cancelar": {
      try {
        const cancelled = await cancelAppointment(repo, { organizationId, appointmentId: appointment.id });
        // Efectos best-effort (cada uno con su SAVEPOINT interno): nunca revierten la
        // cancelación ya hecha. El hueco liberado se ofrece a la lista de espera y el
        // cliente recibe el correo de cancelación si tiene uno en archivo.
        await tryNotifyWaitlistOfFreedSlot(repo, organizationId, timeZone, { providerId: cancelled.providerId, serviceId: cancelled.serviceId, startsAt: cancelled.startsAt });
        await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.cancelled", cancelled.id);
      } catch (err) {
        if (err instanceof AppointmentNotFoundError) return { kind: "reply", reply: NOT_FOUND_REPLY };
        if (err instanceof AppointmentConflictError) return { kind: "reply", reply: `Esa cita (${when}) ya no se puede cancelar desde aquí. Escríbeme y lo vemos.` };
        throw err;
      }
      return { kind: "reply", reply: `Listo, tu cita del ${when} quedó cancelada. Si quieres agendar otra, aquí estoy.` };
    }
    case "reagendar":
      return { kind: "to_agent", text: `Quiero reagendar mi cita del ${when}.` };
  }
}
