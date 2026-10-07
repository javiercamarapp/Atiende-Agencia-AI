// Efectos best-effort que siguen a cancelar/modificar una cita DESDE EL AGENTE o desde un
// botón de WhatsApp (sesión de sistema, UNA sola transacción por request): aviso a la lista
// de espera del hueco liberado y correo al cliente. Mismo orden y mismos helpers que ya usan
// las rutas del agente (`apps/api/.../citas/appointments-lifecycle.ts`).
//
// CONTRATO: nunca lanzan y NUNCA dejan la transacción compartida abortada -- cada lectura/
// escritura corre bajo su propio SAVEPOINT (`repo.runWithRowSavepoint`, o los helpers
// `tryNotifyWaitlistOfFreedSlot`/`tryEnqueueAppointmentEmail` que ya lo hacen por dentro). Un
// error real de Postgres aquí (deadlock, timeout) se traga con SAVEPOINT + ROLLBACK TO
// SAVEPOINT: la cancelación/cambio ya hecho NUNCA se revierte por un efecto secundario.
import { tryEnqueueAppointmentEmail } from "./appointment-email-notifications.ts";
import { notifyWaitlistAfterReschedule, tryNotifyWaitlistOfFreedSlot } from "./reminders.ts";
import type { CitasRepository } from "./repository.ts";
import type { AppointmentRecord } from "./types.ts";
import { tryEnqueueAppointmentWhatsapp } from "./whatsapp/message-send.ts";

const DEFAULT_TIME_ZONE = "America/Mexico_City";

/** Zona horaria efectiva de un proveedor (la de su sucursal, o el default del negocio).
 * Best-effort: ante un error de lectura devuelve el default en vez de lanzar. */
export async function resolveProviderTimeZone(repo: CitasRepository, organizationId: string, providerId: string | null, propertyIdHint: string | null = null): Promise<string> {
  try {
    return await repo.runWithRowSavepoint(async () => {
      const provider = providerId ? await repo.findProvider(organizationId, providerId) : null;
      return repo.findPropertyTimezone(provider?.propertyId ?? propertyIdHint, organizationId);
    });
  } catch (err) {
    console.error("appointment-effects: no se pudo resolver la zona horaria del proveedor (best-effort, se usa la de CDMX):", err);
    return DEFAULT_TIME_ZONE;
  }
}

/** Tras CANCELAR: el horario queda libre -> lista de espera + correo de cancelación. */
export async function runAfterCancelEffects(repo: CitasRepository, organizationId: string, cancelled: AppointmentRecord, timeZone?: string): Promise<void> {
  const tz = timeZone ?? (await resolveProviderTimeZone(repo, organizationId, cancelled.providerId, cancelled.propertyId));
  await tryNotifyWaitlistOfFreedSlot(repo, organizationId, tz, { providerId: cancelled.providerId, serviceId: cancelled.serviceId, startsAt: cancelled.startsAt });
  await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.cancelled", cancelled.id);
}

/** Tras MODIFICAR proveedor/servicio: el hueco (proveedor, servicio, horario) VIEJO queda
 * libre -> lista de espera + correo de "cita modificada". */
export async function runAfterReassignEffects(
  repo: CitasRepository,
  organizationId: string,
  outcome: { readonly appointment: AppointmentRecord; readonly previousProviderId: string; readonly previousServiceId: string },
): Promise<void> {
  const tz = await resolveProviderTimeZone(repo, organizationId, outcome.previousProviderId);
  await tryNotifyWaitlistOfFreedSlot(repo, organizationId, tz, { providerId: outcome.previousProviderId, serviceId: outcome.previousServiceId, startsAt: outcome.appointment.startsAt });
  await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.modified", outcome.appointment.id);
}

/** Tras CANCELAR por el AGENTE (WhatsApp o voz): lo mismo que el boton de cancelar (lista de espera + correo) mas el aviso de WhatsApp opt-in
 * (apagado por defecto) que ya mandan las rutas del panel. Antes la cancelacion por el agente no avisaba a nadie. */
export async function runAfterAgentCancelEffects(repo: CitasRepository, organizationId: string, cancelled: AppointmentRecord): Promise<void> {
  await runAfterCancelEffects(repo, organizationId, cancelled);
  await tryEnqueueAppointmentWhatsapp(repo, organizationId, "appointment.cancelled", cancelled.id);
}

/** Tras REAGENDAR por el agente: el horario VIEJO queda libre -> lista de espera, y correo + WhatsApp opt-in de "cita reagendada". */
export async function runAfterRescheduleEffects(
  repo: CitasRepository,
  organizationId: string,
  outcome: { readonly appointment: AppointmentRecord; readonly previousStartsAt: string },
): Promise<void> {
  const tz = await resolveProviderTimeZone(repo, organizationId, outcome.appointment.providerId, outcome.appointment.propertyId);
  try {
    await notifyWaitlistAfterReschedule(repo, organizationId, tz, { providerId: outcome.appointment.providerId, serviceId: outcome.appointment.serviceId, previousStartsAt: outcome.previousStartsAt, newStartsAt: outcome.appointment.startsAt });
  } catch (err) {
    console.error("appointment-effects: aviso de lista de espera tras reagendar fallo (best-effort):", err);
  }
  await tryEnqueueAppointmentEmail(repo, organizationId, "appointment.rescheduled", outcome.appointment.id, { previousStartsAt: outcome.previousStartsAt });
  await tryEnqueueAppointmentWhatsapp(repo, organizationId, "appointment.rescheduled", outcome.appointment.id, { previousStartsAt: outcome.previousStartsAt });
}
