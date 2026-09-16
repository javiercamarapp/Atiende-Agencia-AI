// Ensambla la app Hono real de apps/api. Deliberadamente SIN ningún middleware
// global de parseo de JSON (`app.use(json())`/`bodyLimit`) — cada ruta lee su propio
// body (`c.req.json()`/`readJsonCapped`/`c.req.raw.arrayBuffer()`), para que
// whatsapp.ts pueda leer bytes crudos sin que nada los haya consumido antes (ver
// comentario crítico en routes/verticals/restaurantes/whatsapp.ts).
import { Hono } from "hono";
import { ApiError, requestId } from "@atiende/core-auth";
import type { AppDeps } from "./deps.ts";
import { logEvent } from "./logger.ts";
import { authRoutes } from "./routes/auth.ts";
import { authGoogleRoutes } from "./routes/auth-google.ts";
import { authMagicLinkRoutes } from "./routes/auth-magic-link.ts";
import { superadminRoutes } from "./routes/superadmin.ts";
import { notificationsRoutes } from "./routes/notifications.ts";
import { restaurantesPublicRoutes } from "./routes/verticals/restaurantes/public.ts";
import { restaurantesVoiceToolsRoutes } from "./routes/verticals/restaurantes/voice-tools.ts";
import { restaurantesWhatsAppRoutes } from "./routes/verticals/restaurantes/whatsapp.ts";
import { restaurantesRoutes } from "./routes/verticals/restaurantes/restaurantes.ts";
import { hotelesRoutes } from "./routes/verticals/hoteles/hoteles.ts";
import { hotelesVoiceToolsRoutes } from "./routes/verticals/hoteles/voice-tools.ts";
import { hotelesWhatsAppRoutes } from "./routes/verticals/hoteles/whatsapp.ts";
import { citasRoutes } from "./routes/verticals/citas/citas.ts";
import { licitacionesRoutes } from "./routes/verticals/licitaciones/licitaciones.ts";
import { despachosRoutes } from "./routes/verticals/despachos/despachos.ts";
import { rentasRoutes } from "./routes/verticals/rentas/rentas.ts";
import { whatsappDispatchRoutes } from "./routes/internal/whatsapp-dispatch.ts";

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Hallazgo de auditoría (observabilidad) — `requestId()` (@atiende/core-auth)
  // existía y varias rutas de licitaciones ya leían `c.get("requestId")` para
  // `correlationId`, pero el middleware nunca se montaba en el pipeline real:
  // fuera de tests que lo montan manualmente, `c.get("requestId")` siempre
  // devolvía `undefined` en producción pese a que `CoreAuthVariables` lo tipa
  // como `string` no-opcional. Montado aquí, primero que nada, para TODA ruta
  // (incluidas las públicas/internas que no pasan por `authMiddleware`) — ver
  // `./logger.ts` (`logEvent`) para cómo el resto de logs estructurados de esta
  // app ahora incluyen este mismo id, y `docs/OBSERVABILIDAD.md` para el detalle
  // completo de qué correlaciona y qué no.
  app.use("*", requestId());

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, err.headers);
    }
    logEvent(c, "error", "apps_api_error_interno", { message: err instanceof Error ? err.message : String(err) });
    return c.json({ code: "internal_error", message: "Error interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", authRoutes(deps));
  app.route("/", authGoogleRoutes(deps));
  app.route("/", authMagicLinkRoutes(deps));
  app.route("/", superadminRoutes(deps));
  app.route("/", notificationsRoutes(deps));
  app.route("/", restaurantesPublicRoutes(deps));
  app.route("/", restaurantesVoiceToolsRoutes(deps));
  app.route("/", restaurantesWhatsAppRoutes(deps));
  app.route("/", restaurantesRoutes(deps));
  app.route("/", hotelesRoutes(deps));
  app.route("/", hotelesVoiceToolsRoutes(deps));
  app.route("/", hotelesWhatsAppRoutes(deps));
  app.route("/", citasRoutes(deps));
  app.route("/", licitacionesRoutes(deps));
  app.route("/", despachosRoutes(deps));
  app.route("/", rentasRoutes(deps));
  // Plataforma compartida (no de un vertical) — drena messaging_outbox de las 3
  // verticales de WhatsApp vía Graph API real, ver ese archivo para el detalle.
  app.route("/", whatsappDispatchRoutes(deps));

  return app;
}
