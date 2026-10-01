// H-01 -- barrido de PURGA POR RETENCION de la boveda de identidad (cron interno).
// SIEMPRE sesion de sistema (`withAppSession({ userId: null })`, la funcion
// `hoteles.purge_expired_identities` exige `auth.uid() is null`) y UNA transaccion POR
// property (una property con datos raros nunca revierte la purga de las demas), con la
// fecha de negocio de CADA property (su zona horaria, ver zona horaria por negocio).
//
// Base sin la migracion 031: la property se reporta `omitida: migracion_pendiente` (no es un
// fallo: el latido queda en ok y nada se purga). Mismo patron que
// revenue-recommendations-cron.ts. NO esta registrado en vercel.json: programarlo es una
// decision de despliegue (ver el cuerpo del PR / docs).
import { Hono } from "hono";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { IdentityUnavailableError, PostgresIdentityRepository, type IdentityRepository } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export interface IdentityPurgeSweepResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly omitida: "migracion_pendiente" | null;
  readonly purgadas: number;
  readonly error: string | null;
}

export async function runIdentityPurgeSweep(deps: AppDeps): Promise<readonly IdentityPurgeSweepResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: IdentityPurgeSweepResult[] = [];
  for (const p of properties) {
    try {
      const purgadas = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo: IdentityRepository = deps.hotelesIdentidadRepo ? deps.hotelesIdentidadRepo(db) : new PostgresIdentityRepository(db);
        return repo.purgeExpired(p.propertyId, hoyFechaNegocio(resolverZonaHorariaNegocio(p.timezone)));
      });
      results.push({ organizationId: p.organizationId, propertyId: p.propertyId, omitida: null, purgadas, error: null });
    } catch (err) {
      if (err instanceof IdentityUnavailableError) {
        results.push({ organizationId: p.organizationId, propertyId: p.propertyId, omitida: "migracion_pendiente", purgadas: 0, error: null });
      } else {
        results.push({ organizationId: p.organizationId, propertyId: p.propertyId, omitida: null, purgadas: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return results;
}

export function hotelesIdentidadPurgaCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/identidad-purga", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/identidad-purga", async () => {
      const results = await runIdentityPurgeSweep(deps);
      const failures = results.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          purgadas_total: results.reduce((n, r) => n + r.purgadas, 0),
          corridas: results.map((r) => ({ organizationId: r.organizationId, propertyId: r.propertyId, omitida: r.omitida, purgadas: r.purgadas, error: r.error })),
        },
        200,
      );
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_identidad_purga_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`identidad-purga: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
