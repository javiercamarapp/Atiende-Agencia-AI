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
// independientemente, así que una reserva con datos raros nunca detiene el resto de
// la corrida.
//
// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #1): ANTES,
// este archivo recibía un `RentasRepository` YA ligado a una única transacción
// abierta por la ruta para TODO el barrido, y usaba `tryEnqueueReservaEmail`
// (variante best-effort que atrapa CUALQUIER error, incluido un error SQL real de
// `enqueueMessagingOutbox`, y devuelve `null`). Un error SQL real en UNA candidata
// dejaba esa transacción ABORTADA (Postgres 25P02); las candidatas siguientes
// fallaban en cascada con ese mismo error engañoso (el catch de `tryEnqueueReservaEmail`
// se lo tragaba, así que ni siquiera aparecía en `fallos` de forma distinguible), y el
// COMMIT final de la ruta -- sobre una transacción abortada -- devolvía el tag
// `ROLLBACK` SIN lanzar (comportamiento documentado de Postgres/node-pg), revirtiendo
// en silencio TODAS las candidatas de esa corrida, incluidas las que ya habían
// encolado su correo y marcado `recordatorio_checkin_enviado_en` con éxito -- la ruta
// seguía respondiendo `ok: true`. El cuerpo original de este PR afirmaba (FALSO) que
// este cron "no requiere este fix" porque "falla honesto"; en realidad tenía EXACTAMENTE
// el mismo patrón que night-audit/cobranza-reminders/alert-notifications (ver
// `WithHotelesRepo` en `apps/worker/src/jobs/hoteles/night-audit.ts` para el detalle
// completo del mecanismo, mismo patrón exacto).
//
// Fix: `runRecordatorioCheckInCore` recibe un runner (`withRepo`) que abre UNA
// transacción por CANDIDATA (la unidad natural del loop, cross-tenant), usa
// `enqueueReservaEmailCore` (deja ver el error real, nunca lo traga) dentro de esa
// transacción, y el catch por candidata del loop de abajo SÍ aísla de verdad: su
// propio ROLLBACK nunca toca las candidatas ya comprometidas (COMMIT real) de las
// anteriores.
import { enqueueReservaEmailCore } from "./reserva-email-notifications.ts";
import { sumarDias } from "./fechas.ts";
import type { RentasRepository } from "./repository.ts";
import type { FechaLocal } from "./tipos.ts";

export type WithRentasRepo = <T>(fn: (repo: RentasRepository) => Promise<T>) => Promise<T>;

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
 * real vía `enqueueReservaEmailCore`.
 *
 * `marcarRecordatorioCheckInEnviado` SOLO se llama tras encolar con éxito (`enqueued
 * === true`) -- mismo criterio que `runConfirmacionCitaCore::markReminderSent`: una
 * reserva sin correo real en archivo (`reason: "sin_correo"`) se deja SIN marcar a
 * propósito, para que si el huésped deja un correo después (fuera de alcance de este
 * cron: hoy no existe un endpoint para editarlo) la siguiente corrida sí la
 * encuentre -- el dedupe_key real del outbox ya evita cualquier duplicado si algo sí
 * llegó a encolarse. Ambas escrituras (encolar + marcar) corren en la MISMA transacción
 * por candidata -- nunca queda un correo encolado sin su marca, ni viceversa.
 *
 * `withRepo` (r4-fix-crons-transaccion-por-unidad): `listReservasProximasACheckIn`
 * corre en su propia transacción corta, y CADA candidata corre la suya.
 */
export async function runRecordatorioCheckInCore(withRepo: WithRentasRepo, now: Date = new Date()): Promise<RecordatorioCheckInSummary> {
  const hoy = hoyUtc(now);
  const desdeFecha = sumarDias(hoy, 1);
  const hastaFecha = sumarDias(hoy, 2);

  const candidatas = await withRepo((repo) => repo.listReservasProximasACheckIn(desdeFecha, hastaFecha));
  const summary: RecordatorioCheckInSummary = { procesadas: candidatas.length, enviados: 0, sinCorreo: 0, fallos: 0 };

  for (const candidata of candidatas) {
    try {
      const resultado = await withRepo(async (repo) => {
        const outcome = await enqueueReservaEmailCore(repo, candidata.organizationId, "reserva.recordatorio_checkin", candidata.ocupacionId);
        if (outcome.enqueued) {
          await repo.marcarRecordatorioCheckInEnviado(candidata.ocupacionId, now.toISOString());
        }
        return outcome;
      });
      if (resultado.enqueued) {
        summary.enviados += 1;
      } else if (resultado.reason === "sin_correo") {
        summary.sinCorreo += 1;
      } else {
        // `reserva_no_encontrada`/`no_es_reserva_confirmada` -- no debería pasar (la
        // consulta ya filtra por reservas confirmadas), pero si pasa NO es un error de
        // infraestructura; se cuenta igual que antes, sin abortar la corrida.
        summary.fallos += 1;
      }
    } catch (err) {
      // Un error SQL real en ESTA candidata -- gracias a que cada candidata corre en
      // su PROPIA transacción (`withRepo`), este catch SÍ aísla de verdad: nunca
      // arrastra ni revierte las candidatas ya procesadas con éxito.
      summary.fallos += 1;
      console.error("checkin-reminders: error procesando candidata", candidata.ocupacionId, err);
    }
  }

  return summary;
}
