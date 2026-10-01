// C-04 -- armado y encolado de los mensajes de WhatsApp configurables (confirmacion, cancelacion, reagendado) y valores de
// las variables. El recordatorio lo arma `runConfirmacionCitaCore` con estos mismos helpers. Todo corre sobre el outbox
// existente (`citas.messaging_outbox`, canal 'whatsapp'): ninguna llamada directa a Meta.
//
// Los tres avisos nacen APAGADOS (`confirmationEnabled`/`cancellationEnabled`/`rescheduleEnabled` = false): un negocio sin
// configuracion guardada, o en una base sin la migracion 026, se comporta exactamente como antes.
import type { CitasRepository } from "../repository.ts";
import { MENSAJES_CONFIG_POR_OMISION, mensajeActivo, plantillaEfectiva, renderizarMensaje, sanitizarValor } from "./message-config.ts";
import type { MensajeKind, ValoresMensaje, WhatsappMessageConfig } from "./message-config.ts";

export type AppointmentWhatsappEvent = "appointment.confirmed" | "appointment.cancelled" | "appointment.rescheduled";

const KIND_POR_EVENTO: Readonly<Record<AppointmentWhatsappEvent, MensajeKind>> = {
  "appointment.confirmed": "confirmacion",
  "appointment.cancelled": "cancelacion",
  "appointment.rescheduled": "reagendado",
};

export interface FechaYHoraLocal {
  readonly fecha: string;
  readonly hora: string;
  readonly fechaHora: string;
}

/** Fecha y hora en la zona horaria REAL del negocio (nunca la del servidor, que corre en UTC). */
export function formatearFechaYHora(iso: string, timeZone: string): FechaYHoraLocal {
  const date = new Date(iso);
  const fecha = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const hora = new Intl.DateTimeFormat("es-MX", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return { fecha, hora, fechaHora: `${fecha}, ${hora}` };
}

export interface CitaParaMensaje {
  readonly providerId: string;
  readonly serviceId: string | null | undefined;
  readonly startsAt: string;
  readonly customerName: string | null;
  readonly previousStartsAt?: string;
}

/** Cache por corrida para no repetir lecturas de negocio/servicio/profesional por cada cita. */
export interface CacheValoresMensaje {
  negocio?: string;
  readonly servicios: Map<string, string>;
  readonly profesionales: Map<string, string>;
}

export function nuevoCacheValores(): CacheValoresMensaje {
  return { servicios: new Map(), profesionales: new Map() };
}

/** Valores de las variables de una cita. Datos de clientes (nombre) se sanitizan; una variable sin dato queda con un texto neutro. */
export async function resolverValoresCita(repo: CitasRepository, organizationId: string, cita: CitaParaMensaje, timeZone: string, cache: CacheValoresMensaje = nuevoCacheValores()): Promise<ValoresMensaje> {
  if (cache.negocio === undefined) cache.negocio = sanitizarValor((await repo.findOrganizationById(organizationId))?.name, 120) || "nuestro negocio";
  let servicio = cita.serviceId ? cache.servicios.get(cita.serviceId) : undefined;
  if (servicio === undefined) {
    servicio = cita.serviceId ? sanitizarValor((await repo.findService(organizationId, cita.serviceId))?.name, 120) || "su servicio" : "su servicio";
    if (cita.serviceId) cache.servicios.set(cita.serviceId, servicio);
  }
  let profesional = cache.profesionales.get(cita.providerId);
  if (profesional === undefined) {
    profesional = sanitizarValor((await repo.findProvider(organizationId, cita.providerId))?.displayName, 120) || "nuestro equipo";
    cache.profesionales.set(cita.providerId, profesional);
  }
  const cuando = formatearFechaYHora(cita.startsAt, timeZone);
  return {
    nombre: sanitizarValor(cita.customerName, 60) || "cliente",
    negocio: cache.negocio,
    servicio,
    profesional,
    fecha: cuando.fecha,
    hora: cuando.hora,
    fecha_hora: cuando.fechaHora,
    ...(cita.previousStartsAt ? { fecha_anterior: formatearFechaYHora(cita.previousStartsAt, timeZone).fechaHora } : {}),
  };
}

/** Texto final de un mensaje con la plantilla del negocio (o la de fabrica). */
export function armarMensaje(config: WhatsappMessageConfig, kind: MensajeKind, valores: ValoresMensaje): string {
  return renderizarMensaje(plantillaEfectiva(config, kind), valores);
}

export interface AppointmentWhatsappResult {
  readonly enqueued: boolean;
  readonly reason?: "disabled" | "appointment_not_found" | "no_phone" | "no_whatsapp_config";
}

/** `phone_number_id` activo desde cualquier sesion: la de staff lee con RLS (null en sesion de sistema) y, si no hay, se
 * intenta la variante de sistema (en una sesion de staff esa lanza 42501, que el SAVEPOINT del repositorio deja recuperada). */
async function resolverPhoneNumberId(repo: CitasRepository, organizationId: string): Promise<string | null> {
  const delStaff = await repo.resolveActiveWhatsAppPhoneNumberId(organizationId);
  if (delStaff) return delStaff;
  try {
    return await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(organizationId);
  } catch {
    return null;
  }
}

export async function enqueueAppointmentWhatsappCore(
  repo: CitasRepository,
  organizationId: string,
  event: AppointmentWhatsappEvent,
  appointmentId: string,
  extra: { readonly previousStartsAt?: string } = {},
): Promise<AppointmentWhatsappResult> {
  const kind = KIND_POR_EVENTO[event];
  const config = (await repo.getWhatsappMessageConfigForSend(organizationId)) ?? MENSAJES_CONFIG_POR_OMISION;
  if (!mensajeActivo(config, kind)) return { enqueued: false, reason: "disabled" };

  const appointment = await repo.findAppointmentForOrganization(organizationId, appointmentId);
  if (!appointment) return { enqueued: false, reason: "appointment_not_found" };
  const customer = await repo.findCustomerById(organizationId, appointment.customerId);
  if (!customer?.phone) return { enqueued: false, reason: "no_phone" };
  const phoneNumberId = await resolverPhoneNumberId(repo, organizationId);
  if (!phoneNumberId) return { enqueued: false, reason: "no_whatsapp_config" };

  const provider = await repo.findProvider(organizationId, appointment.providerId);
  const timeZone = await repo.findPropertyTimezone(provider?.propertyId ?? null, organizationId);
  const valores = await resolverValoresCita(repo, organizationId, { providerId: appointment.providerId, serviceId: appointment.serviceId, startsAt: appointment.startsAt, customerName: customer.fullName ?? null, previousStartsAt: extra.previousStartsAt }, timeZone);

  // Un reagendado distinto del ultimo debe poder avisar de nuevo: el dedupe incluye el horario nuevo.
  const dedupeKey = event === "appointment.rescheduled" ? `wa-rescheduled:${appointmentId}:${appointment.startsAt}` : `wa-${kind}:${appointmentId}`;
  await repo.enqueueMessagingOutbox(organizationId, "whatsapp", event, dedupeKey, { to: customer.phone, phone_number_id: phoneNumberId, body: armarMensaje(config, kind, valores) });
  return { enqueued: true };
}

/**
 * Best-effort: la cita YA se confirmo/cancelo/reagendo; que el aviso falle nunca puede revertirlo ni abortar la transaccion
 * compartida. `runWithRowSavepoint` aisla el intento con SAVEPOINT / ROLLBACK TO SAVEPOINT (mismo criterio que
 * `tryEnqueueAppointmentEmail`).
 */
export async function tryEnqueueAppointmentWhatsapp(
  repo: CitasRepository,
  organizationId: string,
  event: AppointmentWhatsappEvent,
  appointmentId: string,
  extra: { readonly previousStartsAt?: string } = {},
): Promise<AppointmentWhatsappResult | null> {
  try {
    return await repo.runWithRowSavepoint(() => enqueueAppointmentWhatsappCore(repo, organizationId, event, appointmentId, extra));
  } catch (err) {
    console.error("message-send: aviso de WhatsApp best-effort fallo:", err);
    return null;
  }
}
