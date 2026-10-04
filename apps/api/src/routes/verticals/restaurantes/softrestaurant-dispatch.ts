// GET/POST /internal/restaurantes/softrestaurant-dispatch -- drena el outbox de comandas
// de SoftRestaurant (reintentos con backoff). Mismo esquema de secreto que el resto de
// crons (`internalOrCronSecretMatches`: header x-atiende-internal-secret o
// Authorization: Bearer <CRON_SECRET>).
//
// Fail-closed: sin un adaptador REAL (`deps.softRestaurantPort.esReal`) responde 503 y NO
// reclama nada (la alerta de captura manual vencida SI corre antes: no depende del POS) (asi no se gastan intentos contra un POS inexistente). Cada comanda se
// procesa en su PROPIA transaccion (`abrirUnidad`): un envio fallido nunca revierte a los
// demas. Cron en vercel.json (cada 5 minutos, ver docs/CRONS.md); sin adaptador real
// responde 503 en cada corrida (fail-closed, no reclama nada).
import { Hono } from "hono";
import { SIN_BARRIDO_CAPTURA_MANUAL, barrerCapturaManualVencida, crearAlertaCapturaManual, crearResolverSucursalPos, drenarComandas, RESOLVER_SIN_CODIGOS } from "@atiende/domain-restaurantes/softrestaurant";
import type { ResultadoBarridoCapturaManual } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { softRestaurantPortFor, softRestaurantStoreFor } from "./softrestaurant-wiring.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function restaurantesSoftRestauranteDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/restaurantes/softrestaurant-dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/restaurantes/softrestaurant-dispatch", async () => {
      // Alerta de comandas esperando captura manual: va ANTES de revisar el adaptador porque la captura asistida es justo el caso de
      // "sin POS conectado" y no depende de el. Unidad independiente (su propia sesion de sistema): una falla jamas toca el envio.
      let alertas: ResultadoBarridoCapturaManual = SIN_BARRIDO_CAPTURA_MANUAL;
      try {
        alertas = await deps.engine.withAppSession({ userId: null }, (db) => barrerCapturaManualVencida(db, softRestaurantStoreFor(deps, db), { now: new Date() }));
      } catch (err) {
        logEvent(c, "error", "restaurantes_softrestaurant_alerta_captura_manual_fallida", { error: err instanceof Error ? err.message : String(err) });
        alertas = { ...alertas, errores: 1 };
      }
      const port = softRestaurantPortFor(deps);
      if (!port.esReal) {
        return c.json({ ok: false, error: "adaptador real de SoftRestaurant no configurado", alertas }, 503);
      }
      const solicitado = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
      const limite = Number.isFinite(solicitado) && solicitado > 0 ? Math.min(Math.trunc(solicitado), MAX_LIMIT) : DEFAULT_LIMIT;

      const resumen = await drenarComandas(
        {
          port,
          resolverCodigos: deps.softRestaurantMapeo?.resolverCodigos ?? RESOLVER_SIN_CODIGOS,
          resolverSucursal: deps.softRestaurantMapeo?.resolverSucursal ?? crearResolverSucursalPos(),
          abrirUnidad: (fn) =>
            deps.engine.withAppSession({ userId: null }, (db) =>
              fn({ store: softRestaurantStoreFor(deps, db), alertar: crearAlertaCapturaManual(deps.restaurantesRepo(db)) }),
            ),
        },
        limite,
      );
      if (resumen.errores > 0 || resumen.capturaManual > 0) {
        logEvent(c, "error", "restaurantes_softrestaurant_dispatch_con_problemas", { ...resumen });
      }
      return c.json({ ok: resumen.errores === 0, resumen, alertas });
    })();
  });

  return app;
}
