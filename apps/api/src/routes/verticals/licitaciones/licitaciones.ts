// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical
// licitaciones — mismo patrón de montaje que hotelesRoutes/restaurantesPublicRoutes
// en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { licitacionesChecklistRoutes } from "./checklist.ts";
import { licitacionesProposalRoutes } from "./proposalEconomic.ts";
import { licitacionesCierreRoutes } from "./cierre.ts";
import { licitacionesTechnicalProposalRoutes } from "./technicalProposal.ts";
import { licitacionesTendersRoutes } from "./tenders.ts";
import { licitacionesMatchingProfileRoutes } from "./matchingProfile.ts";
import { licitacionesMatchingRoutes } from "./matching.ts";
import { licitacionesGoNoGoRoutes } from "./goNoGo.ts";
import { licitacionesSourcesRoutes } from "./sources.ts";
import { licitacionesTenderVersionsRoutes } from "./tenderVersions.ts";

export function licitacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", licitacionesChecklistRoutes(deps));
  app.route("/", licitacionesProposalRoutes(deps));
  app.route("/", licitacionesCierreRoutes(deps));
  app.route("/", licitacionesTechnicalProposalRoutes(deps));
  // Fase 3 — matching/scoring y go/no-go (ver diseño Fase 3 §8).
  app.route("/", licitacionesTendersRoutes(deps));
  app.route("/", licitacionesMatchingProfileRoutes(deps));
  app.route("/", licitacionesMatchingRoutes(deps));
  app.route("/", licitacionesGoNoGoRoutes(deps));
  // Fase 5 — andamiaje de ingesta (REQ-004/005/146..150) e historial de
  // versiones de convocatoria + diff + cascada de invalidación (REQ-017/041/151..155).
  app.route("/", licitacionesSourcesRoutes(deps));
  app.route("/", licitacionesTenderVersionsRoutes(deps));
  return app;
}
