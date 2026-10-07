// R-42 -- POST/GET /internal/restaurantes/cierres-dia: barrido idempotente que asegura el cierre del dia (y, los domingos cerrados, el
// resumen semanal) de TODAS las sucursales de organizaciones reales (no demo) y avisa en la campana de owner/admin.
//
// NO es un cron de `vercel.json` (decision de costo de Javier: no se agregan crons nuevos). El endpoint queda listo: cualquier
// programador externo o un cron futuro lo invoca con `x-atiende-internal-secret` o `Authorization: Bearer <CRON_SECRET>`. Mientras
// nadie lo agende, los cierres se generan con el boton del panel (cierres.ts).
//
// Idempotente por fecha de negocio: llave unica (sucursal, tipo, fecha de inicio) + `generar_cierre`. Repetir la llamada, o correrla
// dos veces a la vez, deja UN cierre y UN aviso por periodo. `?dias=N` (1..14, por defecto 3) mira los ultimos N dias cerrados, asi un
// dia sin invocar se recupera solo en la siguiente. UNA transaccion por sucursal: un fallo en una no revierte ni frena a las demas.
// Sin PII. Contra la base sin migrar responde `status: "not_available"` (200), nunca un 500.
import { Hono } from "hono";
import { BARRIDO_DIAS_MAX, BARRIDO_DIAS_POR_DEFECTO, barrerCierresSucursal } from "@atiende/domain-restaurantes";
import type { BarridoSucursalResultado } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function restaurantesCierresInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/cierres-dia", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    if (!deps.cierreRepo) throw Errors.serviceUnavailable("Los cierres del día no están disponibles en este despliegue.");
    const cierreRepo = deps.cierreRepo;

    const qDias = c.req.query("dias");
    let dias = BARRIDO_DIAS_POR_DEFECTO;
    if (qDias !== undefined) {
      if (!/^\d{1,2}$/.test(qDias) || Number(qDias) < 1 || Number(qDias) > BARRIDO_DIAS_MAX) throw Errors.validation(`dias debe ser un entero entre 1 y ${BARRIDO_DIAS_MAX}.`);
      dias = Number(qDias);
    }

    // QA R2 automatizacion-12: con latido (visible en /superadmin/salud), bitacora de corridas e interruptor por cron, como el resto de /internal/*.
    // Una sucursal que falla deja la corrida en 'parcial' (CronPartialFailureError), no en 'ok'.
    return withHeartbeat(deps, "/internal/restaurantes/cierres-dia", async () => {
    const ahora = new Date();
    const lista = await deps.engine.withAppSession({ userId: null }, (db) => cierreRepo(db).sucursalesParaBarrido());
    if (!lista.disponible) return c.json({ ok: true, status: "not_available", sucursales: 0, creados: 0, avisos: 0, fallos: [] });

    const resultados: BarridoSucursalResultado[] = [];
    const fallos: { propertyId: string; error: string }[] = [];
    let noDisponible = false;
    for (const sucursal of lista.valor) {
      try {
        // Una transaccion por sucursal: si falla, solo se revierte ESA.
        const r = await deps.engine.withAppSession({ userId: null }, (db) => barrerCierresSucursal({ db, repo: cierreRepo(db), sucursal, ahora, dias }));
        resultados.push(r);
        if (r.noDisponible) noDisponible = true;
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 200) : "error";
        fallos.push({ propertyId: sucursal.propertyId, error });
        logEvent(c, "error", "restaurantes_cierre_barrido_fallo", { propertyId: sucursal.propertyId, error });
      }
    }
    const creados = resultados.reduce((n, r) => n + r.creados, 0);
    const avisos = resultados.reduce((n, r) => n + r.avisos, 0);
    logEvent(c, "info", "restaurantes_cierre_barrido", { sucursales: lista.valor.length, creados, avisos, fallos: fallos.length });
    const respuesta = c.json({
      ok: fallos.length === 0,
      status: noDisponible ? "not_available" : "ok",
      sucursales: lista.valor.length,
      creados,
      existentes: resultados.reduce((n, r) => n + r.existentes, 0),
      sinActividad: resultados.reduce((n, r) => n + r.sinActividad, 0),
      avisos,
      fallos,
    });
    if (fallos.length > 0) throw new CronPartialFailureError(`${fallos.length} sucursal(es) no pudieron cerrar el dia`, respuesta);
    return respuesta;
    })();
  });

  return app;
}
