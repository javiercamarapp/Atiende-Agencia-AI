// H-03 -- expiracion de la cola de aprobaciones humanas (cron interno): por cada property activa marca `expirada` toda
// solicitud pendiente o aprobada-sin-ejecutar cuya vigencia ya paso (hoteles.expire_agent_approvals, migracion 035,
// que exige `auth.uid() is null` y es idempotente). Lo vencido tampoco se puede aprobar ni ejecutar aunque este cron no
// corra (decide/consume revisan la vigencia con el reloj de la base); esto solo mantiene la cola limpia y la bitacora al dia.
//
// SIEMPRE sesion de sistema y UNA transaccion POR property (una property con datos raros nunca revierte las demas;
// mismo patron que tickets-sla-cron.ts). Base sin la 035: la property se reporta `omitida: migracion_pendiente`.
// NO esta registrado en vercel.json: programarlo es una decision de despliegue (ver el cuerpo del PR) -- la ruta acepta
// GET/POST con el secreto interno.
import { Hono } from "hono";
import { AgentesUnavailableError, PostgresAgentesRepository, type AgentesRepository } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export interface AprobacionesExpiracionPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly omitida: "migracion_pendiente" | null;
  readonly expiradas: number;
  readonly error: string | null;
}

export async function runAprobacionesExpiracion(deps: AppDeps, now: Date = new Date()): Promise<readonly AprobacionesExpiracionPropertyResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: AprobacionesExpiracionPropertyResult[] = [];
  for (const p of properties) {
    const base = { organizationId: p.organizationId, propertyId: p.propertyId };
    try {
      const expiradas = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo: AgentesRepository = deps.hotelesAgentesRepo ? deps.hotelesAgentesRepo(db) : new PostgresAgentesRepository(db);
        return repo.expireApprovals(p.propertyId, now);
      });
      results.push({ ...base, omitida: null, expiradas, error: null });
    } catch (err) {
      if (err instanceof AgentesUnavailableError) {
        results.push({ ...base, omitida: "migracion_pendiente", expiradas: 0, error: null });
      } else {
        results.push({ ...base, omitida: null, expiradas: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return results;
}

export function hotelesAgentesExpiracionCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/aprobaciones-expiracion", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/aprobaciones-expiracion", async () => {
      const results = await runAprobacionesExpiracion(deps);
      const failures = results.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          expiradas_total: results.reduce((n, r) => n + r.expiradas, 0),
          corridas: results.map((r) => ({ organizationId: r.organizationId, propertyId: r.propertyId, omitida: r.omitida, expiradas: r.expiradas, error: r.error })),
        },
        200,
      );
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_aprobaciones_expiracion_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`aprobaciones-expiracion: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
