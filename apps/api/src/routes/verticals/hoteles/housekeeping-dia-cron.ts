// H-P3-04 -- el dia de housekeeping arranca solo (cron interno, horario).
//
// Antes "Generar dia" (housekeeping.ts) y "Asignacion automatica" (housekeeping-residual.ts) eran solo botones: si nadie los
// pulsaba, la camarista llegaba sin tareas. Este cron, para cada property activa cuya hora LOCAL ya alcanzo la hora de arranque
// configurada (`housekeeping_config.start_hour`, por omision 07:00):
//   1. genera las tareas del dia con la misma regla que el boton (sucias/ocupadas, sin fuera de servicio ni tarea activa, y sin tarea
//      de estancia si el huesped pidio no ser molestado ese dia -- opt-out);
//   2. si la asignacion automatica esta encendida, reparte las pendientes con la MISMA funcion pura que el boton (`planAutoAssignment`);
//   3. avisa en la campana (`hoteles.housekeeping.dia_generado`, y `hoteles.housekeeping.sin_cupo` si quedaron tareas sin camarista
//      con la asignacion encendida), sin PII.
//
// IDEMPOTENTE por (property, fecha): el ledger `hoteles.housekeeping_day_run` (migracion 045) se reclama con `insert ... on conflict
// do nothing`; la segunda corrida (o un cron solapado) responde `omitida: ya_arrancado` sin generar ni asignar nada. Ventana de
// reintento: se arranca en la hora configurada o en las `VENTANA_ARRANQUE_HORAS - 1` siguientes (si una corrida horaria falla o
// Vercel la omite, la siguiente la recupera); fuera de esa ventana `omitida: fuera_de_horario`.
//
// SIEMPRE sesion de sistema (`withAppSession({ userId: null })`: las tablas de housekeeping tienen RLS por staff, el cron entra por
// las funciones `hoteles.system_hk_*`) y UNA transaccion POR property (generar + asignar + ledger + aviso son atomicos: si algo
// falla, el ledger tambien se revierte y la siguiente corrida reintenta). Base sin la migracion 045: la property se omite
// (`omitida: migracion_pendiente`) sin fallar el latido y el boton "Generar dia" sigue igual. El reloj es un parametro (pruebas).
import { Hono } from "hono";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import { HousekeepingUnavailableError, PostgresHousekeepingDiaSistemaRepository, planAutoAssignment, type HousekeepingDiaSistemaRepository } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

/** La property arranca en su hora configurada y puede recuperar un arranque perdido durante las 2 horas siguientes. */
export const VENTANA_ARRANQUE_HORAS = 3;

export type HousekeepingDiaOmitida = "migracion_pendiente" | "fuera_de_horario" | "ya_arrancado";

export interface HousekeepingDiaPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Fecha de trabajo (dia local de la property) evaluada; null si no se llego a calcular. */
  readonly fecha: string | null;
  readonly omitida: HousekeepingDiaOmitida | null;
  readonly generadas: number;
  readonly asignadas: number;
  /** Tareas pendientes que quedaron sin responsable (por no haber camaristas con cupo o por tener la asignacion apagada). */
  readonly sinAsignar: number;
  readonly error: string | null;
}

/** Fecha y hora LOCALES de `now` en `zona` (nunca el dia/hora UTC del proceso). */
export function fechaYHoraLocal(now: Date, zona: string): { readonly fecha: string; readonly hora: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { fecha: `${get("year")}-${get("month")}-${get("day")}`, hora: Number(get("hour")) % 24 };
}

async function arrancarProperty(deps: AppDeps, p: { organizationId: string; propertyId: string; timezone: string | null }, now: Date): Promise<HousekeepingDiaPropertyResult> {
  const base = { organizationId: p.organizationId, propertyId: p.propertyId };
  const vacio = { generadas: 0, asignadas: 0, sinAsignar: 0, error: null };
  try {
    return await deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo: HousekeepingDiaSistemaRepository = deps.hotelesHousekeepingDiaRepo ? deps.hotelesHousekeepingDiaRepo(db) : new PostgresHousekeepingDiaSistemaRepository(db);
      const cfg = await repo.config(p.propertyId);
      const local = fechaYHoraLocal(now, resolverZonaHorariaNegocio(p.timezone));
      if (local.hora < cfg.startHour || local.hora >= cfg.startHour + VENTANA_ARRANQUE_HORAS) {
        return { ...base, fecha: local.fecha, omitida: "fuera_de_horario" as const, ...vacio };
      }
      const inicio = await repo.startDay(p.propertyId, local.fecha);
      if (!inicio.reclamado) return { ...base, fecha: local.fecha, omitida: "ya_arrancado" as const, ...vacio };

      const tareas = await repo.listDayTasks(p.propertyId, local.fecha);
      const pendientes = tareas.filter((t) => t.status === "pendiente" && t.assignedTo === null);
      let asignadas = 0;
      let sinAsignar = pendientes.length;
      if (cfg.autoAssignEnabled && pendientes.length > 0) {
        const camaristas = await repo.listCamaristas(p.propertyId);
        const cargas = camaristas.map((cam) => {
          const propias = tareas.filter((t) => t.assignedTo === cam.id && t.status !== "cancelada");
          return { camaristaId: cam.id, tasks: propias.length, minutes: propias.reduce((sum, t) => sum + cfg.minutesByType[t.taskType], 0) };
        });
        const plan = planAutoAssignment(pendientes.map((t) => ({ id: t.id, roomCode: t.roomCode, taskType: t.taskType, priority: t.priority })), cargas, cfg);
        sinAsignar = plan.unassigned.length;
        for (const a of plan.assignments) {
          if (await repo.assignTask(p.propertyId, a.taskId, a.camaristaId)) asignadas += 1;
          else sinAsignar += 1;
        }
      }
      await repo.finishDay(p.propertyId, local.fecha, asignadas, sinAsignar);

      // Algo nuevo que atender (REGLA DE NOTIFICACIONES): una por propiedad por dia (dedupe en la base), sin PII, dentro de SAVEPOINT.
      if (inicio.generadas > 0) {
        await emitirNotificacion(db, {
          evento: "hoteles.housekeeping.dia_generado",
          organizationId: p.organizationId,
          propertyId: p.propertyId,
          clave: `${p.propertyId}:${local.fecha}`,
          parametros: { generadas: inicio.generadas, sinAsignar },
        });
      }
      if (cfg.autoAssignEnabled && sinAsignar > 0) {
        await emitirNotificacion(db, {
          evento: "hoteles.housekeeping.sin_cupo",
          organizationId: p.organizationId,
          propertyId: p.propertyId,
          clave: `${p.propertyId}:${local.fecha}`,
          parametros: { cantidad: sinAsignar },
        });
      }
      return { ...base, fecha: local.fecha, omitida: null, generadas: inicio.generadas, asignadas, sinAsignar, error: null };
    });
  } catch (err) {
    if (err instanceof HousekeepingUnavailableError) return { ...base, fecha: null, omitida: "migracion_pendiente", ...vacio };
    return { ...base, fecha: null, omitida: null, generadas: 0, asignadas: 0, sinAsignar: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runHousekeepingDiaSweep(deps: AppDeps, now: Date = new Date()): Promise<readonly HousekeepingDiaPropertyResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: HousekeepingDiaPropertyResult[] = [];
  for (const p of properties) results.push(await arrancarProperty(deps, p, now));
  return results;
}

export function hotelesHousekeepingDiaCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/housekeeping-dia", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/housekeeping-dia", async () => {
      const results = await runHousekeepingDiaSweep(deps);
      const failures = results.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          arrancadas: results.filter((r) => r.omitida === null && r.error === null).length,
          generadas_total: results.reduce((n, r) => n + r.generadas, 0),
          asignadas_total: results.reduce((n, r) => n + r.asignadas, 0),
          corridas: results.map((r) => ({ organizationId: r.organizationId, propertyId: r.propertyId, fecha: r.fecha, omitida: r.omitida, generadas: r.generadas, asignadas: r.asignadas, sinAsignar: r.sinAsignar, error: r.error })),
        },
        200,
      );
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_housekeeping_dia_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`housekeeping-dia: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
