// Ensambla la app Hono real de apps/api. Deliberadamente SIN ningún middleware
// global de parseo de JSON (`app.use(json())`/`bodyLimit`) — cada ruta lee su propio
// body (`c.req.json()`/`readJsonCapped`/`c.req.raw.arrayBuffer()`), para que
// whatsapp.ts pueda leer bytes crudos sin que nada los haya consumido antes (ver
// comentario crítico en routes/verticals/restaurantes/whatsapp.ts).
import { Hono } from "hono";
import { ApiError } from "@atiende/core-auth";
import type { AppDeps } from "./deps.ts";
import { authRoutes } from "./routes/auth.ts";
import { restaurantesPublicRoutes } from "./routes/verticals/restaurantes/public.ts";
import { restaurantesWhatsAppRoutes } from "./routes/verticals/restaurantes/whatsapp.ts";
import { hotelesRoutes } from "./routes/verticals/hoteles/hoteles.ts";
import { licitacionesRoutes } from "./routes/verticals/licitaciones/licitaciones.ts";

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503, err.headers);
    }
    console.error("apps/api error interno:", err);
    return c.json({ code: "internal_error", message: "Error interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/", authRoutes(deps));
  app.route("/", restaurantesPublicRoutes(deps));
  app.route("/", restaurantesWhatsAppRoutes(deps));
  app.route("/", hotelesRoutes(deps));
  app.route("/", licitacionesRoutes(deps));

  return app;
}
