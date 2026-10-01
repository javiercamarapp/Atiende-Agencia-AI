// H-05 -- barrido de SLA de los tickets de huesped (cron interno): por cada property activa, ESCALA a
// gerente/dueno los tickets abiertos/en progreso cuyo SLA ya vencio y AVISA al 75% del SLA a los que aun
// van en tiempo. La logica vive en la funcion SQL `hoteles.sweep_guest_ticket_sla` (migracion 034),
// que exige `auth.uid() is null` (sesion de sistema) y es idempotente: una segunda corrida no vuelve a
// tocar lo ya escalado/avisado.
//
// SIEMPRE sesion de sistema (`withAppSession({ userId: null })`) y UNA transaccion POR property (una
// property con datos raros nunca revierte el barrido de las demas; mismo patron que
// identidad-purga-cron.ts / revenue-recommendations-cron.ts). El reloj es `new Date()` real y se manda
// como PARAMETRO a la funcion (nunca el reloj de la base), para poder simularlo en pruebas.
//
// Base sin la migracion 034: la property se reporta `omitida: migracion_pendiente` (no es un fallo: el
// latido queda en ok y no se toca nada). NO esta registrado en vercel.json: programarlo es una decision
// de despliegue (ver el cuerpo del PR / docs) -- la ruta acepta GET/POST con el secreto interno.
import { Hono } from "hono";
import { PostgresGuestTicketRepository, TicketUnavailableError, type GuestTicketRepository, type SlaSweepItem } from "@atiende/domain-hoteles";
import { emitirNotificacion } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat, CronPartialFailureError } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export interface TicketsSlaSweepPropertyResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly omitida: "migracion_pendiente" | null;
  readonly escalados: number;
  readonly avisados: number;
  readonly items: readonly SlaSweepItem[];
  readonly error: string | null;
}

export async function runTicketsSlaSweep(deps: AppDeps, now: Date = new Date()): Promise<readonly TicketsSlaSweepPropertyResult[]> {
  const properties = await deps.engine.withAppSession({ userId: null }, (db) => deps.hotelesRepo(db).listActiveHotelProperties());
  const results: TicketsSlaSweepPropertyResult[] = [];
  for (const p of properties) {
    const base = { organizationId: p.organizationId, propertyId: p.propertyId };
    try {
      const items = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const repo: GuestTicketRepository = deps.hotelesTicketsRepo ? deps.hotelesTicketsRepo(db) : new PostgresGuestTicketRepository(db);
        const barrido = await repo.sweepSla(p.propertyId, now);
        // Aviso in-app (campana) a gerencia/recepcion cuando hay tickets ESCALADOS por SLA vencido: una por
        // propiedad por dia (clave de dedupe). Dentro de un SAVEPOINT: contra la base sin migrar no revierte el barrido.
        const escalados = barrido.filter((i) => i.kind === "escalado").length;
        if (escalados > 0) {
          await emitirNotificacion(db, {
            evento: "hoteles.ticket.sla_vencido",
            organizationId: p.organizationId,
            propertyId: p.propertyId,
            clave: `${p.propertyId}:${now.toISOString().slice(0, 10)}`,
            parametros: { cantidad: escalados },
          });
        }
        return barrido;
      });
      results.push({ ...base, omitida: null, escalados: items.filter((i) => i.kind === "escalado").length, avisados: items.filter((i) => i.kind === "aviso_sla").length, items, error: null });
    } catch (err) {
      if (err instanceof TicketUnavailableError) {
        results.push({ ...base, omitida: "migracion_pendiente", escalados: 0, avisados: 0, items: [], error: null });
      } else {
        results.push({ ...base, omitida: null, escalados: 0, avisados: 0, items: [], error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return results;
}

export function hotelesTicketsSlaCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/hoteles/tickets-sla", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/tickets-sla", async () => {
      const results = await runTicketsSlaSweep(deps);
      const failures = results.filter((r) => r.error != null);
      const response = c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          escalados_total: results.reduce((n, r) => n + r.escalados, 0),
          avisados_total: results.reduce((n, r) => n + r.avisados, 0),
          corridas: results.map((r) => ({ organizationId: r.organizationId, propertyId: r.propertyId, omitida: r.omitida, escalados: r.escalados, avisados: r.avisados, error: r.error })),
        },
        200,
      );
      if (failures.length > 0) {
        logEvent(c, "error", "hoteles_tickets_sla_cron_con_fallos", { failures: failures.map((f) => ({ propertyId: f.propertyId, error: f.error })) });
        throw new CronPartialFailureError(`tickets-sla: ${failures.length} de ${results.length} properties fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
