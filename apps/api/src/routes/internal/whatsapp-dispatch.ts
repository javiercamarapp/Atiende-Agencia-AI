// GET/POST /internal/whatsapp/dispatch — el dispatcher REAL que faltaba en las 3
// verticales con agente de WhatsApp (citas/hoteles/restaurantes): cada webhook
// (routes/verticals/{citas,hoteles,restaurantes}/whatsapp.ts) ya encola
// `outcome.reply` en su propio `messaging_outbox` (ver whatsapp/inbound.ts de cada
// dominio), pero encolar no es enviar — esta ruta es lo que de verdad drena esas 3
// tablas vía Graph API real (@atiende/whatsapp-gateway::WhatsAppOutboundDispatcher).
//
// Mismo patrón de scheduling que
// apps/api/src/routes/verticals/citas/email-dispatch.ts (hallazgo ALTA de la ronda
// 12: esta ruta existía pero SOLO como app.post con secretMatches, y sin entrada en
// vercel.json::crons nunca se disparaba en producción — el outbox de WhatsApp de
// citas jamás se drenaba). `app.on(["GET", "POST"], ...)` + `internalOrCronSecretMatches`
// aceptan tanto el header manual `x-atiende-internal-secret` (curl/tests) como
// `Authorization: Bearer <CRON_SECRET>` (la única forma en que Vercel Cron invoca
// una ruta, siempre por GET, sin headers custom) — mismo secreto compartido
// (`INTERNAL_SECRET` == `CRON_SECRET`), ver http-security.ts. Wiring real del
// scheduler: vercel.json::crons agrega `/internal/whatsapp/dispatch` (horario
// libre elegido tras revisar los 15 crons ya existentes: "55 14 * * *").
//
// ADVERTENCIA sin verificar desde este código (ver docs/DEPLOY.md, sección de
// costo por plataforma): con esta entrada, vercel.json::crons llega a 16 cron
// jobs totales. Cada uno respeta el límite de frecuencia del plan Hobby de
// Vercel (máximo una vez al día), pero la documentación pública de Vercel
// también ha limitado, en distintos momentos, el NÚMERO TOTAL de cron jobs por
// proyecto en Hobby a una cifra baja (históricamente tan baja como 2) — esto no
// se puede confirmar desde el repo, solo desde el dashboard/plan real de la
// cuenta. Revisar antes de asumir que los 16 se disparan en producción.
//
// Es PLATAFORMA (no de un vertical), por eso vive en routes/internal/ y no en
// routes/verticals/*, y por eso NO se monta desde ningún *Routes(deps) de vertical
// sino directo en apps/api/src/app.ts.
//
// Aislamiento: un vertical roto (tabla mal migrada, repo que lanza) nunca bloquea
// el despacho de las otras dos — mismo criterio que `runConfirmacionCitaCore`
// aísla por organización dentro de citas.
import { Hono } from "hono";
import { createCitasMessagingOutboxPort } from "@atiende/domain-citas";
import { createHotelesMessagingOutboxPort } from "@atiende/domain-hoteles";
import { createRestaurantesMessagingOutboxPort } from "@atiende/domain-restaurantes";
import type { DispatchSummary } from "@atiende/whatsapp-gateway";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import type { AppDeps } from "../../deps.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export function whatsappDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/whatsapp/dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Fail-closed explícito: sin WHATSAPP_ACCESS_TOKEN configurado, no hay
    // integración real que drenar — nunca se finge un envío ni se vacía silenciosamente
    // el outbox marcándolo como procesado.
    const dispatcher = deps.whatsAppDispatcher;
    if (!dispatcher) {
      return c.json({ ok: false, error: "whatsapp dispatcher no configurado (falta WHATSAPP_ACCESS_TOKEN)" }, 503);
    }

    const requestedLimit = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.trunc(requestedLimit), MAX_LIMIT) : DEFAULT_LIMIT;

    const results: Record<string, DispatchSummary | { readonly ok: false; readonly error: string }> = {};
    let anyFailure = false;

    // Un tenant/vertical con datos raros nunca tumba el despacho de los demás —
    // mismo criterio que citasRemindersRoutes captura por organización y sigue.
    for (const vertical of ["citas", "hoteles", "restaurantes"] as const) {
      try {
        const summary = await deps.engine.withAppSession({ userId: null }, async (db) => {
          const port =
            vertical === "citas"
              ? createCitasMessagingOutboxPort(deps.citasRepo(db))
              : vertical === "hoteles"
                ? createHotelesMessagingOutboxPort(deps.hotelesRepo(db))
                : createRestaurantesMessagingOutboxPort(deps.restaurantesRepo(db));
          return dispatcher.dispatchPending(port, { limit });
        });
        results[vertical] = summary;
        if (summary.dead > 0) {
          // No es un fallo de la ruta (el resto del batch sí se despachó bien),
          // pero sí vale la pena que quede en logs de la plataforma para
          // inspección manual de mensajes muertos.
          console.error(`whatsapp-dispatch: ${summary.dead} mensaje(s) de ${vertical} quedaron 'dead' en esta corrida.`);
        }
      } catch (err) {
        anyFailure = true;
        results[vertical] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return c.json({ ok: !anyFailure, results });
  });

  return app;
}
