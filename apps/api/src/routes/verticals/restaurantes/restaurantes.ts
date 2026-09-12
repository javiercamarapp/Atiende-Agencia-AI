// Agregador de las rutas de staff autenticado del vertical restaurantes — mismo
// patrón de montaje que hoteles/hoteles.ts. Separado de public.ts/voice-tools.ts/
// whatsapp.ts (Fase 1-2, sin `authMiddleware`) porque Fase 3 introduce las PRIMERAS
// rutas de staff autenticado de este vertical (ver diseño Fase 3 §0/§2).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { restaurantesAdminKpisRoutes } from "./admin-kpis.ts";
import { restaurantesAdminCatalogRoutes } from "./admin-catalog.ts";
import { restaurantesAdminBranchesRoutes } from "./admin-branches.ts";
import { restaurantesAdminOrdersRoutes } from "./admin-orders.ts";
import { restaurantesAdminCustomersRoutes } from "./admin-customers.ts";

export function restaurantesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", restaurantesAdminKpisRoutes(deps));
  // Fase 5 — back-office CORE (catálogo/sucursales/pedidos/clientes, ver diseño §1).
  app.route("/", restaurantesAdminCatalogRoutes(deps));
  app.route("/", restaurantesAdminBranchesRoutes(deps));
  app.route("/", restaurantesAdminOrdersRoutes(deps));
  app.route("/", restaurantesAdminCustomersRoutes(deps));
  return app;
}
