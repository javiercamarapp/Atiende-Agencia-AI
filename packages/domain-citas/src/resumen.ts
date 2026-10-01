// C-05 -- panel Resumen de citas (paridad con el AdminDashboard del origen): citas de hoy y de la
// semana, pendientes por confirmar, no-shows y clientes nuevos. Solo AGREGA lo que el dominio ya
// guarda (conteos SQL sobre `citas.appointments`/`citas.customers`): ninguna regla de negocio
// nueva y ninguna migración -- las tablas y columnas existen desde 001, así que funciona igual
// contra la base sin migrar.
//
// Zona horaria: "hoy" y "esta semana" son del NEGOCIO (America/Merida, etc.), nunca del servidor
// ni UTC. Una cita a las 22:30 de Mérida (04:30 UTC del día siguiente) cuenta para el día LOCAL.
// La semana es lunes-domingo local.
import { dayOfWeekInTimeZone, zonedDateStr, zonedTimeToUtc } from "./availability.ts";
import type { CitasRepository } from "./repository.ts";
import type { AppointmentStatus } from "./types.ts";

/** Ventana (días) de "no-shows" y "clientes nuevos". */
export const RESUMEN_VENTANA_DIAS = 30;
/** Horizonte (días) de "pendientes por confirmar". */
export const RESUMEN_HORIZONTE_PENDIENTES_DIAS = 30;

export type ResumenPorEstado = Readonly<Record<AppointmentStatus, number>>;

export interface CitasResumen {
  readonly timezone: string;
  readonly generatedAt: string;
  readonly today: { readonly date: string; readonly total: number; readonly byStatus: ResumenPorEstado };
  readonly week: { readonly fromDate: string; readonly toDate: string; readonly total: number; readonly byStatus: ResumenPorEstado };
  /** Citas en estado `pending` con horario futuro dentro de los próximos 30 días. */
  readonly pendingToConfirm: number;
  /** Citas marcadas `no_show` en los últimos 30 días. */
  readonly noShowsLast30Days: number;
  /** Clientes dados de alta en los últimos 30 días. */
  readonly newCustomersLast30Days: number;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Citas "agendadas" = todas menos las canceladas. */
function totalActive(byStatus: ResumenPorEstado): number {
  return byStatus.pending + byStatus.confirmed + byStatus.completed + byStatus.no_show;
}

export async function computeCitasResumen(repo: CitasRepository, organizationId: string, timeZone: string, now: Date = new Date()): Promise<CitasResumen> {
  const todayDate = zonedDateStr(now, timeZone);
  const todayStart = zonedTimeToUtc(todayDate, "00:00", timeZone);
  const tomorrowStart = zonedTimeToUtc(addDays(todayDate, 1), "00:00", timeZone);

  // Semana lunes-domingo LOCAL: dayOfWeekInTimeZone devuelve 0=domingo..6=sábado.
  const weekday = dayOfWeekInTimeZone(todayDate, timeZone);
  const weekStartDate = addDays(todayDate, -((weekday + 6) % 7));
  const nextWeekStartDate = addDays(weekStartDate, 7);
  const weekStart = zonedTimeToUtc(weekStartDate, "00:00", timeZone);
  const nextWeekStart = zonedTimeToUtc(nextWeekStartDate, "00:00", timeZone);

  const dayMs = 24 * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - RESUMEN_VENTANA_DIAS * dayMs);
  const pendingHorizon = new Date(now.getTime() + RESUMEN_HORIZONTE_PENDIENTES_DIAS * dayMs);

  const [today, week, upcoming, past, newCustomers] = await Promise.all([
    repo.countAppointmentsByStatus(organizationId, todayStart.toISOString(), tomorrowStart.toISOString()),
    repo.countAppointmentsByStatus(organizationId, weekStart.toISOString(), nextWeekStart.toISOString()),
    repo.countAppointmentsByStatus(organizationId, now.toISOString(), pendingHorizon.toISOString()),
    repo.countAppointmentsByStatus(organizationId, windowStart.toISOString(), now.toISOString()),
    repo.countCustomersCreatedSince(organizationId, windowStart.toISOString()),
  ]);

  return {
    timezone: timeZone,
    generatedAt: now.toISOString(),
    today: { date: todayDate, total: totalActive(today), byStatus: today },
    week: { fromDate: weekStartDate, toDate: addDays(nextWeekStartDate, -1), total: totalActive(week), byStatus: week },
    pendingToConfirm: upcoming.pending,
    noShowsLast30Days: past.no_show,
    newCustomersLast30Days: newCustomers,
  };
}
