// Correo real de ciclo de vida de una cita — port de
// citas-reservaciones/supabase/functions/_shared/appointment-email-notifications.ts
// sobre `CitasRepository` en vez de un cliente supabase-js crudo. Encola SIEMPRE
// vía `citas.messaging_outbox` con `channel = 'email'` (email-dispatch.ts hace el
// envío real por Resend) — nunca llama a la API de Resend directo desde aquí,
// mismo principio que reminders.ts::runConfirmacionCitaCore/runOptimizadorCore
// nunca llaman a Graph API directo. Un solo outbox genérico para los dos canales
// (ver 003_waitlist_and_rate_limit.sql): mismo dedupe real por
// (organization, canal, dedupe_key).
//
// Cada función se resuelve de forma AUTOSUFICIENTE a partir de solo
// `appointmentId` — mismo principio que tryNotifyWaitlistOfFreedSlot en
// reminders.ts (que vuelve a resolver la organización en vez de confiar en la
// forma exacta que devuelva cada función de appointments.ts): así ningún caller
// (crear-cita, cancelar-cita, reagendar-cita, modificar-cita, o el cron de
// recordatorio 24h) necesita saber qué columnas hacen falta para armar el
// correo.
//
// GAP QUE ESTA FASE CIERRA (Fase 6 §3): las rutas HTTP de citas (apps/api) ya
// encolaban `citas.messaging_outbox` con `channel='email'` en
// `appointment.created`/`cancelled`/`rescheduled` — pero solo con
// `{appointment_id}` como payload, SIN to/subject/html reales (nada en el repo
// armaba el contenido del correo todavía). Este archivo es esa pieza faltante;
// las rutas HTTP se actualizaron para llamar `tryEnqueueAppointmentEmail` en
// vez de encolar el payload incompleto a mano (ver
// apps/api/src/routes/verticals/citas/appointments*.ts).
//
// GAP ADICIONAL QUE CIERRA FASE 11: Fase 7 agregó las 3 transiciones de estado
// confirmar/completar/no-show desde el panel de staff
// (confirmAppointmentFromPanel/completeAppointmentFromPanel/
// markAppointmentNoShowFromPanel en appointments.ts), pero documentó
// explícitamente que NO tenían plantilla de correo — ver
// appointments-lifecycle.ts. Los eventos `appointment.confirmed`/`completed`/
// `no_show` de abajo, y sus rutas correspondientes ya cableadas a
// `tryEnqueueAppointmentEmail`, cierran ese gap.
import {
  correoCitaCancelada,
  correoCitaCompletada,
  correoCitaConfirmada,
  correoCitaCreada,
  correoCitaModificada,
  correoCitaNoShow,
  correoCitaReagendada,
  correoCitaRecordatorio,
  type CitaCorreo,
} from "./emails/appointment-templates.ts";
import type { CitasRepository } from "./repository.ts";

// Fase 11 — agrega confirmed/completed/no_show: gap real de auditoría (ver
// cabecera de emails/appointment-templates.ts). Mismo criterio de dedupe_key
// por evento que las 5 transiciones anteriores.
export type AppointmentEmailEvent =
  | "appointment.created"
  | "appointment.reminder_24h"
  | "appointment.cancelled"
  | "appointment.rescheduled"
  | "appointment.modified"
  | "appointment.confirmed"
  | "appointment.completed"
  | "appointment.no_show";

export interface AppointmentEmailExtra {
  /** Solo relevante para "appointment.rescheduled": el starts_at ANTERIOR de esta misma cita. */
  readonly previousStartsAt?: string;
}

export interface AppointmentEmailResult {
  readonly enqueued: boolean;
  readonly reason?: "no_email" | "appointment_not_found";
}

/**
 * Igual criterio de timezone real que reminders.ts::runConfirmacionCitaCore — el
 * host corre en UTC; SIEMPRE se formatea con el timezone real del negocio
 * (sucursal si existe, si no el de la organización), nunca con el del host.
 */
function formatearFechaHoraLocal(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const fecha = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return `${fecha}, ${hora}`;
}

export async function enqueueAppointmentEmailCore(repo: CitasRepository, organizationId: string, event: AppointmentEmailEvent, appointmentId: string, extra: AppointmentEmailExtra = {}): Promise<AppointmentEmailResult> {
  const appointment = await repo.findAppointmentForOrganization(organizationId, appointmentId);
  if (!appointment) return { enqueued: false, reason: "appointment_not_found" };

  const customer = await repo.findCustomerById(organizationId, appointment.customerId);
  // Sin correo en archivo no es un error — muchos clientes solo dejan teléfono
  // (el canal real de voz/WhatsApp de este motor). El recordatorio por WhatsApp
  // ya cubre a ese cliente; el de correo simplemente no aplica.
  if (!customer?.email) return { enqueued: false, reason: "no_email" };

  const organization = await repo.findOrganizationById(organizationId);
  if (!organization) return { enqueued: false, reason: "appointment_not_found" };

  const provider = await repo.findProvider(organizationId, appointment.providerId);
  const service = await repo.findService(organizationId, appointment.serviceId);

  // Timezone efectivo por sucursal del proveedor — mismo criterio real que el
  // recordatorio de WhatsApp (reminders.ts): sin esto, un negocio con sucursal
  // en otro huso mostraría la hora equivocada al cliente en el correo aunque el
  // de WhatsApp ya la muestre bien.
  const timeZone = await repo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);

  const base: CitaCorreo = {
    clienteNombre: customer.fullName ?? "Cliente",
    tenantNombre: organization.name,
    servicioNombre: service?.name ?? "Servicio",
    proveedorNombre: provider?.displayName ?? "el equipo",
    fechaHoraTexto: formatearFechaHoraLocal(appointment.startsAt, timeZone),
  };

  let correo: { asunto: string; html: string; texto: string };
  let dedupeKey: string;
  switch (event) {
    case "appointment.created":
      correo = correoCitaCreada(base);
      dedupeKey = `created:${appointmentId}`;
      break;
    case "appointment.reminder_24h":
      correo = correoCitaRecordatorio(base);
      // Mismo appointmentId nunca dispara dos veces este evento — el cron ya lo
      // protege con `reminder_24h_sent_at` (ver runConfirmacionCitaCore), pero un
      // dedupe_key propio también cubre un reintento del propio job de correo
      // sin depender de esa columna.
      dedupeKey = `reminder-24h:${appointmentId}`;
      break;
    case "appointment.cancelled":
      correo = correoCitaCancelada(base);
      dedupeKey = `cancelled:${appointmentId}`;
      break;
    case "appointment.rescheduled": {
      const fechaHoraAnteriorTexto = extra.previousStartsAt ? formatearFechaHoraLocal(extra.previousStartsAt, timeZone) : "tu horario anterior";
      correo = correoCitaReagendada({ ...base, fechaHoraAnteriorTexto });
      // Incluye el starts_at nuevo: una cita puede reagendarse más de una vez, y
      // cada reagendado real debe poder mandar su propio correo.
      dedupeKey = `rescheduled:${appointmentId}:${appointment.startsAt}`;
      break;
    }
    case "appointment.modified":
      correo = correoCitaModificada(base);
      // Incluye proveedor/servicio destino: una modificación real a un
      // proveedor/servicio distinto del último correo enviado debe poder mandar
      // el suyo propio.
      dedupeKey = `modified:${appointmentId}:${appointment.providerId}:${appointment.serviceId}`;
      break;
    case "appointment.confirmed":
      correo = correoCitaConfirmada(base);
      dedupeKey = `confirmed:${appointmentId}`;
      break;
    case "appointment.completed":
      correo = correoCitaCompletada(base);
      dedupeKey = `completed:${appointmentId}`;
      break;
    case "appointment.no_show":
      correo = correoCitaNoShow(base);
      dedupeKey = `no-show:${appointmentId}`;
      break;
    default:
      throw new Error(`Evento de correo de cita desconocido: ${String(event)}`);
  }

  await repo.enqueueMessagingOutbox(organizationId, "email", event, dedupeKey, { to: customer.email, subject: correo.asunto, html: correo.html, text: correo.texto });

  return { enqueued: true };
}

/**
 * Envoltura best-effort — mismo principio que
 * reminders.ts::tryNotifyWaitlistOfFreedSlot: la cita YA se creó/canceló/
 * reagendó/modificó con éxito en la base de datos; que no haya correo del
 * cliente en archivo, o que esto falle por cualquier otra razón, NUNCA debe
 * convertirse en un error para quien está agendando, cancelando o reagendando.
 *
 * Arreglo de fondo (auditoría a3, hallazgo confirmado #1, mismo hueco que
 * `tryNotifyWaitlistOfFreedSlot`) — `enqueueAppointmentEmailCore` corre varias
 * consultas reales (`findAppointmentForOrganization`, `findCustomerById`,
 * `findOrganizationById`, `findProvider`, `findService`,
 * `findPropertyTimezone`) más `citas.enqueue_messaging_outbox` sobre el MISMO
 * `TenantDbSession` que la escritura de negocio del caller. ANTES de este fix,
 * un error real de Postgres aquí dentro (p. ej. 25P02 heredado de un
 * `tryNotifyWaitlistOfFreedSlot` anterior en el mismo request/iteración que
 * todavía no tuviera su propio SAVEPOINT) dejaba la transacción del caller
 * abortada -- este catch la tragaba sin recuperarla. `repo.runWithRowSavepoint`
 * aísla el intento con `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`, dejando la sesión
 * utilizable de nuevo para lo que el caller haga después (p. ej. el `commit;`
 * final de la ruta, o la siguiente cita del loop de recordatorio 24h).
 */
export async function tryEnqueueAppointmentEmail(repo: CitasRepository, organizationId: string, event: AppointmentEmailEvent, appointmentId: string, extra: AppointmentEmailExtra = {}): Promise<AppointmentEmailResult | null> {
  try {
    return await repo.runWithRowSavepoint(() => enqueueAppointmentEmailCore(repo, organizationId, event, appointmentId, extra));
  } catch (err) {
    console.error("appointment-email-notifications: best-effort enqueue failed:", err);
    return null;
  }
}
