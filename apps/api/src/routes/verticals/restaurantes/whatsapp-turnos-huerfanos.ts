// GET/POST /internal/restaurantes/whatsapp/turnos-huerfanos — barredor de turnos HUERFANOS del turno asincrono de WhatsApp (cerebro v2 /
// `WHATSAPP_TURNO_ASINCRONO`). Con el 200 a Meta al terminar la fase A, un turno cuya funcion murio (timeout, crash) o cuya fase B fallo ya no lo reintenta
// Meta: este barrido los reclama (migracion 192, atomico con SKIP LOCKED) y los re-ejecuta con `responderTrasEspera`, que contesta solo lo pendiente.
//
// Quien lo dispara:
//   * El propio webhook, en segundo plano y despues de su turno, barre UN huerfano de SU organizacion (ver whatsapp.ts): en horas con trafico los huerfanos
//     se recogen en segundos sin ningun cron.
//   * Esta ruta, para barrer todas las organizaciones. NO esta en `vercel.json::crons`: el proyecto ya usa los 40 crons del plan Pro
//     (apps/api/tests/vercel-crons-contrato.spec.ts). Programarla cada minuto requiere liberar un cupo (decision de Javier; ver docs/CRONS.md).
// Mismo guard que el resto de rutas internas: `x-atiende-internal-secret` o `Authorization: Bearer <CRON_SECRET>`. Sin la 192 responde 200 `not_available`.
// Una transaccion por unidad: el reclamo confirma en la suya y cada huerfano corre en la propia (en paralelo, acotados por HUERFANOS_POR_BARRIDO).
import { Hono } from "hono";
import { HUERFANOS_POR_BARRIDO, liberarTurnoTrasFalloDeFaseB, reclamarTurnosHuerfanos, retomarTurnoHuerfano } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { turnoAsincronoDeEntorno } from "../../../en-segundo-plano.ts";
import { triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

export const RUTA_TURNOS_HUERFANOS = "/internal/restaurantes/whatsapp/turnos-huerfanos";

/** Reclama y re-ejecuta turnos huerfanos. `inicioMs` = inicio de la funcion (el turno usa la vida de 60 s contada desde ahi). null = sin la 192. */
export async function barrerTurnosHuerfanosWhatsApp(deps: AppDeps, opts: { readonly inicioMs: number; readonly organizationId: string | null; readonly limite: number }): Promise<number | null> {
  const reclamar = deps.reclamarTurnosHuerfanos ?? reclamarTurnosHuerfanos;
  const lista = await deps.engine.withAppSession({ userId: null }, (db) => reclamar(db, { organizationId: opts.organizationId, todas: turnoAsincronoDeEntorno(), limite: opts.limite }));
  if (lista === null) return null;
  await Promise.all(
    lista.map(async (h) => {
      try {
        await deps.engine.withAppSession({ userId: null }, async (db) => {
          const repo = deps.restaurantesRepo(db);
          await retomarTurnoHuerfano(repo, deps.turnHandler, h, {
            inicioMs: opts.inicioMs,
            reloj: deps.relojMs ?? Date.now,
            ...(deps.privacidadRepo ? { privacy: deps.privacidadRepo(db) } : {}),
            ...(deps.handoffGate ? { handoffGate: deps.handoffGate(db) } : {}),
          });
          await triggerRestaurantesWhatsAppDispatchInline(deps, db, repo);
          await triggerRestaurantesEmailDispatchInline(deps, db, repo);
        });
      } catch {
        // La transaccion del huerfano no confirmo: se marca `failed` y se suelta su turno para el siguiente barrido (igual que la fase B del webhook).
        if (!h.phone) return;
        const phone = h.phone;
        await deps.engine
          .withAppSession({ userId: null }, async (db) => liberarTurnoTrasFalloDeFaseB(deps.restaurantesRepo(db), { organizationId: h.organizationId, messageId: h.messageId, phone }))
          .catch(() => undefined);
      }
    }),
  );
  return lista.length;
}

export function restaurantesWhatsAppTurnosHuerfanosRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], RUTA_TURNOS_HUERFANOS, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const inicioMs = (deps.relojMs ?? Date.now)();
    const retomados = await barrerTurnosHuerfanosWhatsApp(deps, { inicioMs, organizationId: null, limite: HUERFANOS_POR_BARRIDO });
    // Sin PII: solo el conteo.
    logEvent(c, "info", "restaurantes_whatsapp_turnos_huerfanos", { retomados: retomados ?? 0, disponible: retomados !== null });
    return c.json({ ok: true, status: retomados === null ? "not_available" : "ok", retomados: retomados ?? 0 });
  });

  return app;
}
