// H-06 -- LIBERACION AUTOMATICA POR CUTOFF de bloqueos de grupos (ruta interna): por cada property activa libera lo NO
// confirmado de los bloqueos activos cuya fecha de liberacion ya llego EN LA ZONA HORARIA DE ESA PROPERTY
// (hoteles.group_release_due, migracion 036, que exige `auth.uid() is null` y es idempotente), y vence las propuestas cuya
// vigencia paso (hoteles.group_expire_quotes). Lo confirmado (pickup) NUNCA se libera.
//
// SIEMPRE sesion de sistema y UNA transaccion POR property (una property con datos raros nunca revierte las demas; mismo
// patron que agentes-expiracion-cron.ts). Base sin la 036: la property se reporta `omitida: migracion_pendiente`.
// Cron diario en vercel.json (ver docs/CRONS.md); la ruta
// acepta GET/POST con el secreto interno.
import { Hono } from "hono";
import { GruposUnavailableError, PostgresGruposRepository, type GruposRepository } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export interface GruposLiberacionPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly omitida: "migracion_pendiente" | null;
  readonly bloqueosLiberados: number;
  readonly cuartosNocheLiberados: number;
  readonly error: string | null;
}

export interface GruposLiberacionResult {
  readonly properties: readonly GruposLiberacionPropertyResult[];
  /** Propuestas vencidas por vigencia (barrido global, una sola transaccion). null = base sin migrar o fallo (ver `errorVencimiento`). */
  readonly cotizacionesVencidas: number | null;
  readonly errorVencimiento: string | null;
}

export async function runGruposLiberacion(deps: AppDeps, now: Date = new Date()): Promise<GruposLiberacionResult> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const repoOf = (db: Parameters<NonNullable<AppDeps["hotelesGruposRepo"]>>[0]): GruposRepository => (deps.hotelesGruposRepo ? deps.hotelesGruposRepo(db) : new PostgresGruposRepository(db));
  const results: GruposLiberacionPropertyResult[] = [];
  for (const p of properties) {
    const base = { organizationId: p.organizationId, propertyId: p.propertyId };
    try {
      const released = await deps.engine.withAppSession({ userId: null }, (db) => repoOf(db).releaseDueBlocks(p.propertyId, now));
      results.push({
        ...base, omitida: null, bloqueosLiberados: released.length, cuartosNocheLiberados: released.reduce((n, r) => n + r.releasedRoomNights, 0), error: null,
      });
    } catch (err) {
      if (err instanceof GruposUnavailableError) {
        results.push({ ...base, omitida: "migracion_pendiente", bloqueosLiberados: 0, cuartosNocheLiberados: 0, error: null });
      } else {
        results.push({ ...base, omitida: null, bloqueosLiberados: 0, cuartosNocheLiberados: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  let cotizacionesVencidas: number | null = null;
  let errorVencimiento: string | null = null;
  try {
    cotizacionesVencidas = await deps.engine.withAppSession({ userId: null }, (db) => repoOf(db).expireQuotes(now));
  } catch (err) {
    if (!(err instanceof GruposUnavailableError)) errorVencimiento = err instanceof Error ? err.message : String(err);
  }
  return { properties: results, cotizacionesVencidas, errorVencimiento };
}

export function hotelesGruposLiberacionCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/grupos-liberacion", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/grupos-liberacion", async () => {
      const result = await runGruposLiberacion(deps);
      const failures = result.properties.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0 && result.errorVencimiento === null,
          properties_revisadas: result.properties.length,
          bloqueos_liberados_total: result.properties.reduce((n, r) => n + r.bloqueosLiberados, 0),
          cuartos_noche_liberados_total: result.properties.reduce((n, r) => n + r.cuartosNocheLiberados, 0),
          cotizaciones_vencidas: result.cotizacionesVencidas,
          corridas: result.properties.map((r) => ({
            organizationId: r.organizationId, propertyId: r.propertyId, omitida: r.omitida, bloqueosLiberados: r.bloqueosLiberados,
            cuartosNocheLiberados: r.cuartosNocheLiberados, error: r.error,
          })),
        },
        200,
      );
      if (failures.length > 0 || result.errorVencimiento !== null) {
        logEvent(c, "error", "hoteles_grupos_liberacion_cron_con_fallos", {
          failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })), errorVencimiento: result.errorVencimiento,
        });
        throw new CronPartialFailureError(`grupos-liberacion: ${failures.length} de ${result.properties.length} properties fallaron${result.errorVencimiento ? " y el vencimiento de propuestas fallo" : ""}`, response);
      }
      return response;
    })();
  });

  return app;
}
