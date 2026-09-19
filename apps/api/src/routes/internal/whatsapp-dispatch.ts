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
//      INLINE best-effort, mismo `repo`/transacción del caller, para intentar
//      enviar YA en vez de esperar al cron. Lo llaman los 3 webhooks de
//      citas/hoteles/restaurantes (sesión de SISTEMA, ahí SÍ logra despachar) Y
//      también `verticals/restaurantes/{admin-orders,repartidor-orders}.ts`
//      (sesión de STAFF -- desactualizado hasta la revisión de PR #169: este
//      comentario decía "cada webhook" cuando Fase 8 ya había agregado esos 2
//      call sites de staff sin actualizarlo). En sesión de staff
//      `claim_messaging_outbox_batch` SIEMPRE lanza 42501 (guard cross-tenant,
//      ver más abajo) -- ese intento inline ahí es un no-op seguro por diseño;
//      el envío real en esos 2 call sites lo hace `dispatchWhatsAppVertical`
//      encolado en `postCommitTasks` (sesión de SISTEMA, DESPUÉS del commit,
//      mismo patrón que `hoteles/folios.ts::runHotelesEmailDispatch` de PR
//      #166). Mismo principio de "nunca propaga, nunca abre sesión nueva
//      dentro de la transacción del caller" que
//      `@atiende/domain-citas::tryTriggerGoogleSync`: un fallo aquí NUNCA se
//      propaga al caller HTTP (el mensaje ya quedó en el outbox pase lo que
//      pase) y NUNCA abre su propia sesión de BD nueva -- recibe el repo YA
//      abierto en la transacción del request que encoló, para poder VER esa
//      fila recién insertada (una sesión nueva, en una transacción Postgres
//      aparte, no vería un INSERT todavía sin commit de la transacción del
//      request -- ver comentario largo de dbSession en
//      @atiende/core-auth/src/middleware.ts).
//
// Hotfix (auditoría a2b, CRÍTICO, primo directo del hallazgo cerrado en PR #166
// para el drenado de correo) -- `triggerInline` recibe también `db` (el MISMO
// `TenantDbSession` de `c.get("db")`/`withAppSession`, nunca uno nuevo) para
// envolver `dispatcher.dispatchPending(...)` en `SAVEPOINT`. `<vertical>.
// claim_messaging_outbox_batch` (ver migrations/007_messaging_outbox*.sql +
// migrations/0{15,17,19}_messaging_outbox_dispatch_authenticated_grants.sql de
// cada vertical) tiene EXACTAMENTE el mismo guard `if auth.uid() is not null
// then raise exception ... using errcode = '42501'` que `claim_email_outbox_batch`
// -- lanza SIEMPRE en sesión de STAFF (`auth.uid()` no nulo), guard correcto y
// necesario (la función es cross-tenant), NO se toca. Sin este SAVEPOINT esa
// excepción deja la transacción de negocio COMPLETA abortada (25P02) hasta un
// `ROLLBACK TO SAVEPOINT`: el `commit;` del motor sobre una transacción abortada
// no lanza error (Postgres responde "ROLLBACK" en silencio, ver
// packages/db/src/managed-postgres-engine.ts), así que la escritura de negocio de
// ESTE MISMO request (p.ej. el cambio de estado de un pedido, ver
// verticals/restaurantes/{admin-orders,repartidor-orders}.ts) se pierde con un
// 2xx. A diferencia del fix de correo, aquí el `SAVEPOINT` inicial vive DENTRO
// del `try` (no antes): si la transacción YA venía abortada por otra causa
// anterior a este trigger, emitir `SAVEPOINT` también lanza 25P02 -- afuera del
// try eso habría convertido este disparo best-effort en una excepción nueva sin
// capturar (no-bloqueante señalado en la revisión de PR #166, corregido aquí
// desde el inicio). Ver `scripts/verify-whatsapp-inline-sesion-staff/` para la
// prueba ANTES/DESPUÉS contra Postgres real.
import { Hono } from "hono";
import { createCitasMessagingOutboxPort } from "@atiende/domain-citas";
import type { CitasRepository } from "@atiende/domain-citas";
import { createHotelesMessagingOutboxPort } from "@atiende/domain-hoteles";
import type { HotelesRepository } from "@atiende/domain-hoteles";
import { createRestaurantesMessagingOutboxPort } from "@atiende/domain-restaurantes";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import type { DispatchSummary, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import { withHeartbeat } from "../../salud/with-heartbeat.ts";
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

const SAVEPOINT_NAME = "sp_inline_whatsapp_dispatch";

/** Núcleo compartido de los 3 disparadores inline de abajo -- nunca exportado
 *  directo (cada vertical construye su propio `port` con su propio tipo de
 *  repo, ver comentario de cabecera de por qué el repo debe venir YA abierto en
 *  la transacción del caller).
 *
 *  `db` es el MISMO `TenantDbSession` en el que vive `port` (ver comentario de
 *  cabecera del archivo, hotfix auditoría a2b) -- el `SAVEPOINT` inicial va
 *  DENTRO del `try` a propósito: si `db` ya traía la transacción abortada por
 *  otra causa, `SAVEPOINT` también lanza 25P02, y sin el `try` alrededor eso
 *  se propagaría como una excepción NUEVA fuera de este trigger best-effort.
 *
 *  Trade-off aceptado (no bloqueante, señalado en revisión de PR #169; mismo
 *  trade-off ya aceptado en #166 para correo): si `dispatchPending` avanza a
 *  mitad de lote antes de lanzar (p.ej. ya hizo `claim` + `markSent` de algún
 *  mensaje y el error real ocurre después, en `breaker.reportFailure`/
 *  `markRetry`), el `ROLLBACK TO SAVEPOINT` de abajo revierte TODO el lote
 *  completo -- incluido lo que sí se envió por Graph API. En la ruta de webhook
 *  (sesión SANA, sin abort real) eso puede provocar que el cron reintente un
 *  envío que el cliente YA recibió. Se acepta porque el mensaje reintentado es
 *  idempotente a nivel de negocio (mismo texto, sin costo de doble cobro) y
 *  porque acotar el SAVEPOINT solo al `claim` exigiría partir
 *  `dispatchPending` en dos transacciones separadas -- fuera de alcance de
 *  este hotfix (ver `scripts/verify-whatsapp-inline-sesion-staff/README.md`
 *  para la referencia cruzada). */
async function triggerInline(deps: AppDeps, vertical: WhatsAppMessagingVertical, db: TenantDbSession, port: MessagingOutboxPort, limit: number): Promise<void> {
  const dispatcher = deps.whatsAppDispatcher;
  if (!dispatcher) return; // Sin token configurado: nada que intentar inline, el cron ya responde 503 si se invoca directo.
  try {
    await db.exec(`SAVEPOINT ${SAVEPOINT_NAME}`);
    const summary = await dispatcher.dispatchPending(port, { limit });
    await db.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    if (summary.dead > 0) {
      console.error(`whatsapp-dispatch inline: ${summary.dead} mensaje(s) de ${vertical} quedaron 'dead' en el drenado inline.`);
    }
  } catch (err) {
    try {
      await db.exec(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
      await db.exec(`RELEASE SAVEPOINT ${SAVEPOINT_NAME}`);
    } catch (recoveryErr) {
      // Si el propio SAVEPOINT nunca llegó a crearse (transacción ya abortada
      // de entrada, ver comentario de arriba), este ROLLBACK TO también falla
      // -- se traga aquí a propósito, nunca se propaga (best-effort real).
      console.error(`whatsapp-dispatch inline: fallo recuperando el SAVEPOINT para ${vertical} (no debería pasar):`, recoveryErr);
    }
    // Nunca se propaga: el mensaje ya quedó en el outbox, el cron diario
    // (red de seguridad de respaldo) lo recoge en la siguiente corrida.
    console.error(`whatsapp-dispatch inline: fallo best-effort para ${vertical}, el cron diario lo recogerá:`, err);
  }
}

/** Disparo inline best-effort para citas -- llamar justo después de que
 *  `handleInboundWhatsAppMessage` (o cualquier acción del agente) encoló una
 *  respuesta en `citas.messaging_outbox`, pasando el MISMO `db`/`citasRepo` ya
 *  abiertos en la transacción de ese request. */
export async function triggerCitasWhatsAppDispatchInline(deps: AppDeps, db: TenantDbSession, citasRepo: CitasRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "citas", db, createCitasMessagingOutboxPort(citasRepo), limit);
}

/** Mismo principio que `triggerCitasWhatsAppDispatchInline`, para hoteles. */
export async function triggerHotelesWhatsAppDispatchInline(deps: AppDeps, db: TenantDbSession, hotelesRepo: HotelesRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "hoteles", db, createHotelesMessagingOutboxPort(hotelesRepo), limit);
}

/** Mismo principio que `triggerCitasWhatsAppDispatchInline`, para restaurantes. */
export async function triggerRestaurantesWhatsAppDispatchInline(deps: AppDeps, db: TenantDbSession, restaurantesRepo: RestaurantesRepository, limit: number = INLINE_LIMIT): Promise<void> {
  await triggerInline(deps, "restaurantes", db, createRestaurantesMessagingOutboxPort(restaurantesRepo), limit);
}

export function whatsappDispatchRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/whatsapp/dispatch", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/whatsapp/dispatch", async () => {
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
      // NOTA para "Salud operativa" (ver ../../salud/motor.ts): este cron NUNCA
      // lanza por verticales fallidas (aisladas a propósito, ver arriba) -- por
      // eso `withHeartbeat` lo registra como latido 'ok' aunque `anyFailure` sea
      // true; la señal de verticales fallidas/mensajes muertos vive en los logs
      // estructurados de arriba y en `core.get_outbox_health_for_superadmin`
      // (conteo de 'dead' real por cola), NUNCA en el estado del latido del cron.
      if (anyFailure) {
        logEvent(c, "error", "whatsapp_dispatch_cron_con_verticales_fallidas", {
          failedVerticals,
          failedCount: failedVerticals.length,
          totalDead,
        });
      }

      return c.json({ ok: !anyFailure, results });
    })();
  });

  return app;
}
