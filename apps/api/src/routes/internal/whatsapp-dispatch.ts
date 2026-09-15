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
//
// CLUSTER #3 de la auditoría final (CRÍTICO): hasta este cambio, el ÚNICO
// disparador de esta ruta era el cron diario de arriba — un mensaje entrante de
// WhatsApp podía tardar hasta ~24h en obtener respuesta real (el producto se
// vende como agente CONVERSACIONAL). La corrección real vive en dos partes:
//
//   1. Esta ruta sigue existiendo tal cual (red de seguridad de respaldo real:
//      cualquier mensaje que el paso 2 no haya podido enviar en el momento
//      -- WHATSAPP_ACCESS_TOKEN caído, Graph API con rate-limit, el propio
//      request que encoló muriendo antes de disparar el drenado -- lo recoge
//      esta corrida diaria, nunca se pierde en silencio).
//   2. `triggerCitasWhatsAppDispatchInline`/`triggerHotelesWhatsAppDispatchInline`/
//      `triggerRestaurantesWhatsAppDispatchInline` (exportados abajo) -- disparo
//      INLINE best-effort que cada webhook de citas/hoteles/restaurantes llama él
//      mismo justo después de encolar la respuesta, para intentar enviarla YA en
//      vez de esperar al cron. Mismo principio que
//      `@atiende/domain-citas::tryTriggerGoogleSync`: un fallo aquí NUNCA se
//      propaga al caller HTTP (el mensaje ya quedó en el outbox pase lo que
//      pase) y NUNCA abre su propia sesión de BD nueva -- recibe el repo YA
//      abierto en la transacción del request que encoló, para poder VER esa
//      fila recién insertada (una sesión nueva, en una transacción Postgres
//      aparte, no vería un INSERT todavía sin commit de la transacción del
//      request -- ver comentario largo de dbSession en
//      @atiende/core-auth/src/middleware.ts).
import { Hono } from "hono";
import { createCitasMessagingOutboxPort } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { createHotelesMessagingOutboxPort } from "@atiende/domain-hoteles";
import type { HotelesRepository } from "@atiende/domain-hoteles";
import { createRestaurantesMessagingOutboxPort } from "@atiende/domain-restaurantes";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { DispatchSummary, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import type { AppDeps } from "../../deps.ts";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
/** Límite del drenado INLINE -- deliberadamente chico (a diferencia de
 *  DEFAULT_LIMIT del cron, que barre lote completo): el webhook de WhatsApp de
 *  Meta espera una respuesta rápida, y en el caso real (un mensaje entrante
 *  generó una respuesta) casi siempre hay 0-1 filas pendientes que drenar. Un
 *  límite chico acota el peor caso de latencia añadida al webhook sin dejar de
 *  intentar el envío real inmediato; cualquier remanente lo recoge el cron. */
const INLINE_LIMIT = 5;

export type WhatsAppMessagingVertical = "citas" | "hoteles" | "restaurantes";
export type WhatsAppVerticalDispatchResult = DispatchSummary | { readonly ok: false; readonly error: string };

function isFailureResult(result: WhatsAppVerticalDispatchResult): result is { readonly ok: false; readonly error: string } {
  return "ok" in result && result.ok === false;
}

/**
 * Drena el outbox de WhatsApp de UN vertical, abriendo SU PROPIA sesión de
 * sistema -- correcto para el cron (no hay ninguna transacción de request en
 * curso de la que "heredar" visibilidad) y NUNCA debe usarse desde un disparo
 * inline dentro de un request que todavía no hizo commit (ver
 * `triggerXWhatsAppDispatchInline` de abajo para ese caso). Nunca lanza por un
 * fallo de negocio del dispatch (Graph API caída, dispatcher no configurado,
 * sesión de BD rota) -- lo devuelve como parte del resultado para que el loop
 * de la ruta de cron pueda aislar un vertical roto de los otros dos.
 */
export async function dispatchWhatsAppVertical(deps: AppDeps, vertical: WhatsAppMessagingVertical, limit: number): Promise<WhatsAppVerticalDispatchResult> {
  const dispatcher = deps.whatsAppDispatcher;
  if (!dispatcher) return { ok: false, error: "whatsapp dispatcher no configurado (falta WHATSAPP_ACCESS_TOKEN)" };

  try {
    return await deps.engine.withAppSession({ userId: null }, async (db) => {
      const port =
        vertical === "citas"
          ? createCitasMessagingOutboxPort(deps.citasRepo(db))
          : vertical === "hoteles"
            ? createHotelesMessagingOutboxPort(deps.hotelesRepo(db))
            : createRestaurantesMessagingOutboxPort(deps.restaurantesRepo(db));
      return dispatcher.dispatchPending(port, { limit });
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Núcleo compartido de los 3 disparadores inline de abajo -- nunca exportado
 *  directo (cada vertical construye su propio `port` con su propio tipo de
 *  repo, ver comentario de cabecera de por qué el repo debe venir YA abierto en
 *  la transacción del caller). */
async function triggerInline(deps: AppDeps, vertical: WhatsAppMessagingVertical, port: MessagingOutboxPort, limit: number): Promise<void> {
  const dispatcher = deps.whatsAppDispatcher;
  if (!dispatcher) return; // Sin token configurado: nada que intentar inline, el cron ya responde 503 si se invoca directo.
  try {
    const summary = await dispatcher.dispatchPending(port, { limit });
    if (summary.dead > 0) {
      console.error(`whatsapp-dispatch inline: ${summary.dead} mensaje(s) de ${vertical} quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    // Nunca se propaga: el mensaje ya quedó en el outbox, el cron diario
    // (red de seguridad de respaldo) lo recoge en la siguiente corrida.
    console.error(`whatsapp-dispatch inline: fallo best-effort para ${vertical}, el cron diario lo recogerá:`, err);
  }
}

/** Disparo inline best-effort para citas -- llamar justo después de que
 *  `handleInboundWhatsAppMessage` (o cualquier acción del agente) encoló una
 *  respuesta en `citas.messaging_outbox`, pasando el MISMO `citasRepo` ya
 *  abierto en la transacción de ese request. */
export async function triggerCitasWhatsAppDispatchInline(deps: AppDeps, citasRepo: CitasRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "citas", createCitasMessagingOutboxPort(citasRepo), limit);
}

/** Mismo principio que `triggerCitasWhatsAppDispatchInline`, para hoteles. */
export async function triggerHotelesWhatsAppDispatchInline(deps: AppDeps, hotelesRepo: HotelesRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "hoteles", createHotelesMessagingOutboxPort(hotelesRepo), limit);
}

/** Mismo principio que `triggerCitasWhatsAppDispatchInline`, para restaurantes. */
export async function triggerRestaurantesWhatsAppDispatchInline(deps: AppDeps, restaurantesRepo: RestaurantesRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "restaurantes", createRestaurantesMessagingOutboxPort(restaurantesRepo), limit);
}

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

    const results: Record<string, WhatsAppVerticalDispatchResult> = {};
    let anyFailure = false;
    let totalDead = 0;
    const failedVerticals: string[] = [];

    // Un tenant/vertical con datos raros nunca tumba el despacho de los demás —
    // mismo criterio que citasRemindersRoutes captura por organización y sigue.
    for (const vertical of ["citas", "hoteles", "restaurantes"] as const) {
      const result = await dispatchWhatsAppVertical(deps, vertical, limit);
      results[vertical] = result;
      if (isFailureResult(result)) {
        anyFailure = true;
        failedVerticals.push(vertical);
      } else if (result.dead > 0) {
        totalDead += result.dead;
        // No es un fallo de la ruta (el resto del batch sí se despachó bien),
        // pero sí vale la pena que quede en logs de la plataforma para
        // inspección manual de mensajes muertos.
        logEvent(c, "error", "whatsapp_dispatch_mensajes_dead", { vertical, dead: result.dead });
      }
    }

    // HALLAZGO ALTO de la auditoría final: este handler respondía 200 HTTP
    // aunque el lote entero fallara por dentro (p.ej. las 3 verticales
    // arrojando excepción), así que nadie se enteraba nunca de un fallo real de
    // la corrida diaria. DECISIÓN DOCUMENTADA: no se cambia el status code de
    // la respuesta -- Vercel Cron únicamente entiende 200 como "el job corrió"
    // (ver docs/DEPLOY.md#resumen-de-costo-por-plataforma); devolver un 5xx
    // aquí convertiría cada fallo real en reintentos agresivos de Vercel sobre
    // un job que de por sí ya aísla fallos por vertical, sin ganar visibilidad
    // real (Vercel Cron no tiene alerta propia por status code en el plan
    // Hobby). La corrección real es dejar esta corrida LOGUEADA estructurada
    // con severidad `error` y el conteo de verticales fallidas/mensajes
    // muertos -- consumible por cualquier integración de logs (Sentry,
    // Logtail, `vercel logs`, etc.) sin tocar el contrato HTTP del cron.
    if (anyFailure) {
      logEvent(c, "error", "whatsapp_dispatch_cron_con_verticales_fallidas", {
        failedVerticals,
        failedCount: failedVerticals.length,
        totalDead,
      });
    }

    return c.json({ ok: !anyFailure, results });
  });

  return app;
}
