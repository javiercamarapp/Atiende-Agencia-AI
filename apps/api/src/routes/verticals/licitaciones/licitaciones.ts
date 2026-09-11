// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical
// licitaciones — mismo patrón de montaje que hotelesRoutes/restaurantesPublicRoutes
// en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { licitacionesChecklistRoutes } from "./checklist.ts";
import { licitacionesProposalRoutes } from "./proposalEconomic.ts";
import { licitacionesCierreRoutes } from "./cierre.ts";

export function licitacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", licitacionesChecklistRoutes(deps));
  app.route("/", licitacionesProposalRoutes(deps));
  app.route("/", licitacionesCierreRoutes(deps));
  return app;
}
