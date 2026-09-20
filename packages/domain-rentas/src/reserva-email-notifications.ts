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
import type { TenantDbSession } from "@atiende/core-tenancy";
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

const RESERVA_EMAIL_SAVEPOINT_NAME = "sp_reserva_email_best_effort";

/**
 * Hallazgo de auditoría (a3, rentas — parte de los elementos "best-effort sin
 * SAVEPOINT" de citas/rentas/hoteles/despachos/restaurantes) — mismo defecto y mismo
 * fix EXACTO que `@atiende/domain-restaurantes::order-notifications.ts::
 * runNotifyBestEffort`: `POST .../rentas/.../reservas` (reservas.ts:158) llama a
 * `tryEnqueueReservaEmail` con el MISMO `TenantDbSession`/transacción del request que
 * ya corrió `crearReservaConfirmada` + `insertGuestMinimo` — un try/catch plano
 * alrededor de `enqueueReservaEmailCore` (que hace varias consultas reales, incluida
 * `select rentas.enqueue_messaging_outbox(...)`, ver `enqueueMessagingOutbox`) deja la
 * transacción ABORTADA ante CUALQUIER error real de Postgres (deadlock, timeout,
 * permission denied contra una base sin migrar), y el `commit;` final de
 * `ManagedPostgresEngine.withAppSession` se convierte en un `ROLLBACK` silencioso — la
 * reserva que YA se había creado con éxito en esta misma transacción se pierde con una
 * respuesta 2xx.
 *
 * `db` (opcional) es el MISMO `TenantDbSession` de la transacción del caller — cuando
 * se pasa, este best-effort corre protegido por SAVEPOINT (mismo criterio que
 * `runNotifyBestEffort`: si el propio `db` ya traía la transacción abortada por una
 * causa AJENA a este best-effort, el `SAVEPOINT` también lanza 25P02 — se traga aquí
 * también, nunca se relanza). Cuando `db` no se pasa (`runRecordatorioCheckInCore`, que
 * usa `enqueueReservaEmailCore` DIRECTO en su propia transacción por candidata, nunca
 * esta variante) no aplica -- pero se deja el parámetro opcional por si algún caller
 * futuro de sesión de sistema sin transacción compartida la necesita sin SAVEPOINT.
 */
export async function tryEnqueueReservaEmail(repo: RentasRepository, organizationId: string, event: ReservaEmailEvent, ocupacionId: string, db?: TenantDbSession): Promise<ReservaEmailResult | null> {
  if (!db) {
    try {
      return await enqueueReservaEmailCore(repo, organizationId, event, ocupacionId);
    } catch (err) {
      console.error("reserva-email-notifications: best-effort enqueue failed:", err);
      return null;
    }
  }
  try {
    await db.exec(`SAVEPOINT ${RESERVA_EMAIL_SAVEPOINT_NAME}`);
    const resultado = await enqueueReservaEmailCore(repo, organizationId, event, ocupacionId);
    await db.exec(`RELEASE SAVEPOINT ${RESERVA_EMAIL_SAVEPOINT_NAME}`);
    return resultado;
  } catch (err) {
    try {
      await db.exec(`ROLLBACK TO SAVEPOINT ${RESERVA_EMAIL_SAVEPOINT_NAME}`);
      await db.exec(`RELEASE SAVEPOINT ${RESERVA_EMAIL_SAVEPOINT_NAME}`);
    } catch (recoveryErr) {
      // Si el propio SAVEPOINT nunca llegó a crearse (transacción ya abortada de
      // entrada, por una causa AJENA a este best-effort), este ROLLBACK TO también
      // falla -- se traga aquí a propósito, igual que `runNotifyBestEffort`.
      console.error("reserva-email-notifications: fallo recuperando el SAVEPOINT del best-effort (no debería pasar):", recoveryErr);
    }
    console.error("reserva-email-notifications: best-effort enqueue failed:", err);
    return null;
  }
}
