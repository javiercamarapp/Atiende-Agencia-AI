// Agregador de las rutas de staff autenticado del vertical restaurantes — mismo
// patrón de montaje que hoteles/hoteles.ts. Separado de public.ts/voice-tools.ts/
// whatsapp.ts (Fase 1-2, sin `authMiddleware`) porque Fase 3 introduce las PRIMERAS
// rutas de staff autenticado de este vertical (ver diseño Fase 3 §0/§2).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { restaurantesAdminKpisRoutes } from "./admin-kpis.ts";

export function restaurantesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", restaurantesAdminKpisRoutes(deps));
  return app;
}
