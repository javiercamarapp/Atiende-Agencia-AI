// Recordatorio de check-in 24-48h antes -- job periódico real que cierra la segunda
// mitad del gap de auditoría (la primera es reserva-email-notifications.ts::
// "reserva.creada", encolada al crear la reserva). Mismo patrón que
// `domain-citas::reminders.ts::runConfirmacionCitaCore` (barrido por ventana +
// best-effort + marcar enviado solo tras encolar con éxito), adaptado a que
// domain-rentas trabaja check-in como una FECHA de calendario (`YYYY-MM-DD`, ver
// tipos.ts::FechaLocal), no un timestamp con hora -- así que la ventana "24-48h
// antes" se expresa en días de calendario `[hoy+1, hoy+2]`, calculada con el mismo
// `Date.UTC` puro de fechas.ts (README Fase 1 §1-#8: domain-rentas nunca convierte
// zona horaria de pared, los 3 flujos originales no lo necesitan).
//
// Barrido GLOBAL de la plataforma (sin loop por organización) -- mismo criterio que
// `rentasIcalSyncCronRoutes::listFeedsActivos`: cada ocupación se procesa
// independientemente vía `tryEnqueueReservaEmail` (best-effort real, nunca lanza), así
// que una reserva con datos raros nunca detiene el resto de la corrida.
import { tryEnqueueReservaEmail } from "./reserva-email-notifications.ts";
import { sumarDias } from "./fechas.ts";
import type { RentasRepository } from "./repository.ts";
import type { FechaLocal } from "./tipos.ts";

export interface RecordatorioCheckInSummary {
  procesadas: number;
  enviados: number;
  sinCorreo: number;
  fallos: number;
}

function hoyUtc(now: Date): FechaLocal {
  return now.toISOString().slice(0, 10);
}

/**
 * Corrida real: encuentra toda reserva directa confirmada cuyo check-in caiga entre
 * mañana y pasado mañana (`[hoy+1, hoy+2]`, la ventana de 24-48h antes expresada en
 * fechas de calendario) y que todavía no recibió el recordatorio, y encola el correo
 * real vía `tryEnqueueReservaEmail`.
 *
 * `marcarRecordatorioCheckInEnviado` SOLO se llama tras encolar con éxito (`enqueued
 * === true`) -- mismo criterio que `runConfirmacionCitaCore::markReminderSent`: una
 * reserva sin correo real en archivo (`reason: "sin_correo"`) se deja SIN marcar a
 * propósito, para que si el huésped deja un correo después (fuera de alcance de este
 * cron: hoy no existe un endpoint para editarlo) la siguiente corrida sí la
 * encuentre -- el dedupe_key real del outbox ya evita cualquier duplicado si algo sí
 * llegó a encolarse.
 */
export async function runRecordatorioCheckInCore(repo: RentasRepository, now: Date = new Date()): Promise<RecordatorioCheckInSummary> {
  const hoy = hoyUtc(now);
  const desdeFecha = sumarDias(hoy, 1);
  const hastaFecha = sumarDias(hoy, 2);

  const candidatas = await repo.listReservasProximasACheckIn(desdeFecha, hastaFecha);
  const summary: RecordatorioCheckInSummary = { procesadas: candidatas.length, enviados: 0, sinCorreo: 0, fallos: 0 };

  for (const candidata of candidatas) {
    const resultado = await tryEnqueueReservaEmail(repo, candidata.organizationId, "reserva.recordatorio_checkin", candidata.ocupacionId);
    if (resultado?.enqueued) {
      summary.enviados += 1;
      await repo.marcarRecordatorioCheckInEnviado(candidata.ocupacionId, now.toISOString());
    } else if (resultado?.reason === "sin_correo") {
      summary.sinCorreo += 1;
    } else {
      // `null` (falló, ver tryEnqueueReservaEmail) o cualquier otro `reason` --
      // nunca debe detener el resto de la corrida.
      summary.fallos += 1;
    }
  }

  return summary;
}
