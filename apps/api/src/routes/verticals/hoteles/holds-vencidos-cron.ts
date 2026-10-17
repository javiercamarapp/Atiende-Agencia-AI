// H-P3-03 -- barrido de pre-reservas (holds) vencidas del agente de reservas (cron interno, cada 15 minutos).
//
// `hoteles.booking_hold_expire_due` (migracion 037) existia pero nadie lo llamaba: el vencimiento solo ocurria cuando el agente
// volvia a operar en esa property, asi que una habitacion podia quedar retenida horas despues de vencer el plazo. Este cron
// libera el inventario de TODA property activa aunque el agente no se use.
//
// SIEMPRE sesion de sistema (`withAppSession({ userId: null })`; la funcion SQL exige `auth.uid() is null`) y UNA transaccion POR
// property (una property con datos raros nunca revierte el barrido de las demas; mismo patron que tickets-sla-cron.ts). El reloj es
// `new Date()` real y se manda como PARAMETRO a la funcion (nunca el de la base) para poder simularlo en pruebas. Idempotente: una
// segunda corrida no encuentra nada vencido. Base sin la migracion 037: la property se reporta `omitida: migracion_pendiente` (no es
// un fallo: el latido queda en ok y no se toca nada). Cron en vercel.json; la ruta acepta GET/POST con el secreto interno.
import { Hono } from "hono";
import { PostgresReservasAgenteRepository, ReservasAgenteUnavailableError, type ReservasAgenteRepository } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { runCicloMensajesHuesped } from "./mensajes-huesped.ts";

export interface HoldsVencidosPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly omitida: "migracion_pendiente" | null;
  /** Pre-reservas que esta corrida paso a vencidas (y cuyo inventario libero). */
  readonly vencidos: number;
  readonly error: string | null;
}

export async function runHoldsVencidosSweep(deps: AppDeps, now: Date = new Date()): Promise<readonly HoldsVencidosPropertyResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: HoldsVencidosPropertyResult[] = [];
  for (const p of properties) {
    const base = { organizationId: p.organizationId, propertyId: p.propertyId };
    try {
      const vencidos = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo: ReservasAgenteRepository = deps.hotelesReservasAgenteRepo ? deps.hotelesReservasAgenteRepo(db) : new PostgresReservasAgenteRepository(db);
        return repo.expireDueHolds(p.propertyId, now);
      });
      results.push({ ...base, omitida: null, vencidos, error: null });
    } catch (err) {
      if (err instanceof ReservasAgenteUnavailableError) results.push({ ...base, omitida: "migracion_pendiente", vencidos: 0, error: null });
      else results.push({ ...base, omitida: null, vencidos: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export function hotelesHoldsVencidosCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/holds-vencidos", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/holds-vencidos", async () => {
      const results = await runHoldsVencidosSweep(deps);
      // H-P3-03: mismo ritmo (*/15) y mismo cron (vercel.json esta en el tope de 40): despues de liberar las pre-reservas vencidas se
      // emiten los avisos al huesped (incluido `hold.vencido`). Es best-effort: un fallo aqui jamas tumba ni oculta el barrido de holds.
      const mensajes = await runCicloMensajesHuesped(deps).then(
        (r) => ({ disponible: r.disponible, encolados: r.encolados, no_enviados: r.noEnviados, errores: r.errores }),
        (err: unknown) => {
          logEvent(c, "error", "hoteles_mensajes_huesped_ciclo_fallo", { error: err instanceof Error ? err.message : String(err) });
          return { disponible: false, encolados: 0, no_enviados: 0, errores: 1 };
        },
      );
      const failures = results.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          vencidos_total: results.reduce((n, r) => n + r.vencidos, 0),
          mensajes_huesped: mensajes,
          corridas: results.map((r) => ({ organizationId: r.organizationId, propertyId: r.propertyId, omitida: r.omitida, vencidos: r.vencidos, error: r.error })),
        },
        200,
      );
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_holds_vencidos_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`holds-vencidos: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
