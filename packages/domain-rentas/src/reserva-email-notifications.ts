// Correo real de ciclo de vida de una reserva directa -- cierra el gap identificado
// por auditoría (ver apps/api/src/routes/verticals/rentas/reservas.ts, comentario
// histórico "el envío de correo de confirmación al huésped ... se difiere a Fase 2":
// ya hay motor de correo real en el monorepo, domain-citas lo trajo en su Fase 6 §3 —
// esta fase lo porta a rentas). Mismo principio que
// domain-citas::appointment-email-notifications.ts: encola SIEMPRE vía
// `rentas.messaging_outbox` con `channel='email'` (../email-dispatch.ts hace el envío
// real por Resend), nunca llama a la API de Resend directo desde aquí.
//
// Cada función se resuelve de forma AUTOSUFICIENTE a partir de solo `ocupacionId` --
// mismo principio que `domain-citas::enqueueAppointmentEmailCore`: ningún caller
// (POST reservas.ts, o el cron de recordatorio de check-in) necesita saber qué
// columnas hacen falta para armar el correo.
//
// Deliberadamente DISTINTO de src/mensajeria/* (Fase 7, H-056 a H-061): estos DOS
// correos (confirmación al crear, recordatorio de check-in) son transaccionales/
// deterministas -- una plantilla fija con datos reales de la reserva, sin IA y sin
// cola de aprobación humana. El borrador de mensajería de canal (Airbnb/Vrbo/
// Booking, con o sin IA) SIEMPRE pasa por colaAprobacion.ts antes de salir; un correo
// de "tu reserva quedó confirmada" no es contenido generado que alguien deba
// aprobar -- ver el comentario de cabecera de ./emails/reserva-templates.ts.
import { correoReservaConfirmada, correoReservaRecordatorioCheckIn, type ReservaCorreoDatos } from "./emails/reserva-templates.ts";
import type { RentasRepository } from "./repository.ts";
import type { FechaLocal } from "./tipos.ts";

export type ReservaEmailEvent = "reserva.creada" | "reserva.recordatorio_checkin";

export interface ReservaEmailResult {
  readonly enqueued: boolean;
  readonly reason?: "sin_correo" | "reserva_no_encontrada" | "no_es_reserva_confirmada";
}

// Validación deliberadamente simple (RFC 5322 completo es innecesario aquí): basta
// para distinguir "este `contacto` es un correo" de "es un teléfono u otro texto
// libre" -- `rentas.guest_minimo.contacto` es un campo único sin columna de tipo
// (migrations/001), ver comentario de OcupacionParaCorreo.huespedContacto en
// types.ts. Nunca se envía nada a un `contacto` que no calce este patrón.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Igual criterio que `domain-rentas::fechas.ts` (README Fase 1 §1-#8): domain-rentas
 * solo trabaja fechas de calendario puras (`YYYY-MM-DD`), nunca conversión de zona
 * horaria de pared -- se formatea en UTC, consistente con `Date.UTC` del resto del
 * paquete, nunca con el timezone del proceso Node que ejecuta el cron. */
function formatearFechaCalendario(fecha: FechaLocal): string {
  const date = new Date(`${fecha}T00:00:00Z`);
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}

export async function enqueueReservaEmailCore(repo: RentasRepository, organizationId: string, event: ReservaEmailEvent, ocupacionId: string): Promise<ReservaEmailResult> {
  const ocupacion = await repo.findOcupacionParaCorreo(organizationId, ocupacionId);
  if (!ocupacion) return { enqueued: false, reason: "reserva_no_encontrada" };

  // Solo una reserva DIRECTA 'confirmado' amerita un correo transaccional al
  // huésped -- nunca un bloqueo (propietario/mantenimiento/buffer, sin huésped),
  // nunca una 'provisional'/'conflicto_pendiente' (todavía no es una estancia real
  // que confirmarle a nadie).
  if (ocupacion.capa !== "reserva" || ocupacion.estado !== "confirmado") {
    return { enqueued: false, reason: "no_es_reserva_confirmada" };
  }

  const contacto = ocupacion.huespedContacto;
  // Sin correo real en `contacto` no es un error -- muchas reservas solo dejan
  // teléfono, o ni siquiera eso (huespedNombre/huespedContacto son opcionales en
  // POST reservas.ts). El correo simplemente no aplica para esta reserva.
  if (!contacto || !EMAIL_RE.test(contacto)) return { enqueued: false, reason: "sin_correo" };

  const datos: ReservaCorreoDatos = {
    huespedNombre: ocupacion.huespedNombre ?? "Huésped",
    tenantNombre: ocupacion.tenantNombre,
    unidadNombre: ocupacion.unidadNombre,
    checkInTexto: formatearFechaCalendario(ocupacion.rango.inicio),
    checkOutTexto: formatearFechaCalendario(ocupacion.rango.fin),
  };

  let correo: { asunto: string; html: string; texto: string };
  let dedupeKey: string;
  switch (event) {
    case "reserva.creada":
      correo = correoReservaConfirmada(datos);
      dedupeKey = `creada:${ocupacionId}`;
      break;
    case "reserva.recordatorio_checkin":
      correo = correoReservaRecordatorioCheckIn(datos);
      // Mismo ocupacionId nunca dispara dos veces este evento -- el cron ya lo
      // protege con `recordatorio_checkin_enviado_en` (ver ../checkin-reminders.ts),
      // pero un dedupe_key propio también cubre un reintento del propio dispatcher
      // de correo sin depender de esa columna.
      dedupeKey = `recordatorio-checkin:${ocupacionId}`;
      break;
    default: {
      const _exhaustive: never = event;
      throw new Error(`Evento de correo de reserva desconocido: ${String(_exhaustive)}`);
    }
  }

  await repo.enqueueMessagingOutbox(ocupacion.propertyId, organizationId, "email", event, dedupeKey, { to: contacto, subject: correo.asunto, html: correo.html, text: correo.texto });

  return { enqueued: true };
}

/**
 * Envoltura best-effort -- mismo principio que
 * `domain-citas::tryEnqueueAppointmentEmail`: la reserva YA se creó con éxito en la
 * base de datos (o ya existía, en el caso del recordatorio); que no haya correo del
 * huésped en archivo, o que esto falle por cualquier otra razón, NUNCA debe
 * convertirse en un error para quien está creando la reserva ni tumbar la corrida
 * del cron de recordatorio.
 */
export async function tryEnqueueReservaEmail(repo: RentasRepository, organizationId: string, event: ReservaEmailEvent, ocupacionId: string): Promise<ReservaEmailResult | null> {
  try {
    return await enqueueReservaEmailCore(repo, organizationId, event, ocupacionId);
  } catch (err) {
    console.error("reserva-email-notifications: best-effort enqueue failed:", err);
    return null;
  }
}
