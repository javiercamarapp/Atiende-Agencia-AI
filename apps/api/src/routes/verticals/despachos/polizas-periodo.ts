// D-P3-14 -- cron DIARIO de las polizas del periodo (secreto interno/cron, sesion de sistema, latido y kill switch via withHeartbeat):
//
//  /internal/despachos/polizas-periodo    diario -- por cada CFDI del periodo (mes en curso y dos anteriores) que ya se puede contabilizar sin
//                                                    manos, registra su poliza; avisa en la campana (`despachos.libro.polizas_generadas`, dedupe por
//                                                    cliente y dia, solo la cantidad, sin PII).
//
// Cada CFDI corre en su PROPIA transaccion de sistema (un error SQL real en uno no aborta ni revierte los demas). Compatible con la base sin migrar:
// sin la migracion 026 responde `no_disponible` (200, nada contabilizado), nunca un 500. Las reglas de que es "contabilizable" viven en la base
// (`system_polizas_periodo_candidatos`) y en `construirPolizaDesdeCfdi`; el boton equivalente del panel es `POST .../libro/polizas/generar-periodo` (libro.ts).
import { Hono } from "hono";
import { emitirNotificacion } from "@atiende/db";
import type { EmitirNotificacionInput } from "@atiende/db";
import { PostgresPolizasPeriodoRepository } from "@atiende/domain-despachos";
import { runPolizasPeriodoSistema } from "@atiende/worker";
import type { WithUnidadPolizasPeriodo } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function despachosPolizasPeriodoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const withUnidad: WithUnidadPolizasPeriodo = (fn) =>
    deps.engine.withAppSession({ userId: null }, (db) =>
      fn({ repo: deps.polizasPeriodoRepo ? deps.polizasPeriodoRepo(db) : new PostgresPolizasPeriodoRepository(db), notificar: (n) => emitirNotificacion(db, n as EmitirNotificacionInput) }),
    );

  app.on(["GET", "POST"], "/internal/despachos/polizas-periodo", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/despachos/polizas-periodo", async () => {
      const r = await runPolizasPeriodoSistema(withUnidad);
      const body = {
        ok: r.fallidos.length === 0,
        status: r.estado,
        candidatos: r.candidatos,
        generadas: r.generadas,
        omitidas: r.omitidas,
        no_armables: r.noArmables,
        clientes_avisados: r.clientesAvisados,
        cortado_por_tiempo: r.cortadoPorTiempo,
        failures: r.fallidos.map((f) => ({ invoice_id: f.invoiceId, property_id: f.propertyId, error: f.error })),
      };
      const response = c.json(body, 200);
      if (r.fallidos.length > 0) throw new CronPartialFailureError(`polizas-periodo: ${r.fallidos.length} fallo(s) de ${r.candidatos} candidatos`, response);
      return response;
    })();
  });

  return app;
}
