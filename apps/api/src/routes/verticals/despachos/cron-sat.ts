// Crons de despachos de la ronda D-26/D-27/D-28 (secreto interno/cron, sesion de sistema, latido y kill switch via withHeartbeat):
//
//  /internal/despachos/cfdi-estatus-sat           semanal  -- consulta el estatus de los CFDI ante el SAT (publico), por lotes,
//                                                             los mas antiguos primero, con tope por corrida.
//  /internal/despachos/efos-69b/descarga          mensual  -- baja la lista 69-B (CSV publico), la ingiere (idempotente por SHA-256 y
//                                                             periodo) y alerta los CFDI ya ingeridos que toca la edicion nueva.
//  /internal/despachos/vencimientos-barrido       diario   -- genera las obligaciones del periodo en curso (y rellena el anterior si no
//                                                             corrio) por cliente con ficha y escala/avisa las que vencen en 7, 3 o 1 dia(s)
//                                                             habil(es), hoy o ya vencieron, con aviso in-app y correo (D-P3-33).
//
// Cada unidad de trabajo (un CFDI, un cliente, un grupo de alertas) corre en su PROPIA transaccion de sistema: un error SQL real en
// una unidad no aborta ni revierte las demas. Compatibles con la base sin migrar: sin la migracion 022 responden `no_disponible`
// (200, nada barrido), nunca un 500. Los avisos in-app salen de `emitirNotificacion` (catalogo, dedupe por clave, sin PII).
import { Hono } from "hono";
import { emitirNotificacion } from "@atiende/db";
import type { EmitirNotificacionInput } from "@atiende/db";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { ConsultaCfdiSatSoap, PostgresCronSatRepository } from "@atiende/domain-despachos";
import type { DespachosRepository } from "@atiende/domain-despachos";
import { HttpEfos69bSource, runCfdiEstatusSatSweep, runEfos69bDescarga, runVencimientosBarridoSistema } from "@atiende/worker";
import type { WithUnidadCronSat } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function despachosCronSatRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  const withUnidad: WithUnidadCronSat = (fn) =>
    deps.engine.withAppSession({ userId: null }, (db) =>
      fn({ repo: deps.cronSatRepo ? deps.cronSatRepo(db) : new PostgresCronSatRepository(db), notificar: (n) => emitirNotificacion(db, n as EmitirNotificacionInput) }),
    );

  app.on(["GET", "POST"], "/internal/despachos/cfdi-estatus-sat", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/despachos/cfdi-estatus-sat", async () => {
      const r = await runCfdiEstatusSatSweep(withUnidad, deps.consultaCfdiSat ?? new ConsultaCfdiSatSoap());
      const body = {
        ok: r.fallidos.length === 0,
        status: r.estado,
        revisados: r.revisados,
        vigentes: r.vigentes,
        cancelados: r.cancelados,
        no_encontrados: r.noEncontrados,
        sin_concluir: r.sinConcluir,
        nuevos_cancelados: r.nuevosCancelados,
        cortado_por_tiempo: r.cortadoPorTiempo,
        failures: r.fallidos.map((f) => ({ invoice_id: f.invoiceId, error: f.error })),
      };
      const response = c.json(body, 200);
      if (r.fallidos.length > 0) throw new CronPartialFailureError(`cfdi-estatus-sat: ${r.fallidos.length} CFDI fallaron`, response);
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/despachos/efos-69b/descarga", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/despachos/efos-69b/descarga", async () => {
      const withRepo = <T>(fn: (repo: DespachosRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.despachosRepo(db)));
      const source = deps.efos69bSource ?? new HttpEfos69bSource({ url: deps.env.efos69bUrl });
      const r = await runEfos69bDescarga(withRepo, withUnidad, source, hoyFechaNegocio().slice(0, 7));
      const body = {
        ok: r.estado !== "fallo" && r.alertasFallidas === 0,
        status: r.estado,
        periodo: r.periodo,
        resultado: r.resultado,
        filas: r.filas,
        descartadas: r.descartadas,
        alertas_emitidas: r.alertasEmitidas,
        alertas_fallidas: r.alertasFallidas,
        detalle: r.detalle ?? null,
      };
      const response = c.json(body, 200);
      if (r.estado === "fallo" || r.alertasFallidas > 0) throw new CronPartialFailureError(`efos-69b-descarga: ${r.detalle ?? `${r.alertasFallidas} alertas fallaron`}`, response);
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/despachos/vencimientos-barrido", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/despachos/vencimientos-barrido", async () => {
      const r = await runVencimientosBarridoSistema(withUnidad);
      const body = {
        ok: r.fallidos.length === 0,
        status: r.estado,
        clientes: r.clientes,
        creados: r.creados,
        rellenados: r.rellenados,
        omitidos: r.omitidos,
        escalados: r.escalados,
        ya_escalados: r.yaEscalados,
        correos_encolados: r.correosEncolados,
        failures: r.fallidos.map((f) => ({ property_id: f.propertyId, error: f.error })),
      };
      const response = c.json(body, 200);
      if (r.fallidos.length > 0) throw new CronPartialFailureError(`vencimientos-barrido: ${r.fallidos.length} de ${r.clientes} clientes fallaron`, response);
      return response;
    })();
  });

  return app;
}
