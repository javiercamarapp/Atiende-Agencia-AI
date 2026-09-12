// Fase 3 pieza 2 (lectura) — licitacionesMatchingRoutes: `GET
// base/tenders/:tenderId/matching` (detalle) y `GET base/tenders/matching`
// (lista, todas las convocatorias de la organización) -- ver diseño Fase 3
// §4/§8. Solo LECTURA: el score se recalcula en vivo en cada request contra
// el perfil de matching actual (nunca se persiste un score cacheado que
// pudiera desincronizarse -- mismo principio "nunca confiar en un valor
// guardado que pueda quedar obsoleto" que `PackageAssembler`/AE-14 en
// cierre.ts). Cualquier miembro de la organización puede leer: ver el score
// no es una decisión, decidir go/no-go sí lo es (ver goNoGo.ts).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MatchingEngine, toOrganizationMatchingProfile } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesMatchingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.licitacionesRepo;
  const engine = new MatchingEngine();
  const listBase = "/licitaciones/:propertyId/tenders/matching";
  const detailBase = "/licitaciones/:propertyId/tenders/:tenderId/matching";

  app.use(listBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(detailBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(listBase, async (c) => {
    const organizationId = c.get("organizationId");
    const [tenders, profileRecord] = await Promise.all([repo.listTenders(organizationId), repo.findMatchingProfile(organizationId)]);
    const profile = toOrganizationMatchingProfile(profileRecord, organizationId);
    const results = tenders.map((tender) => engine.score(tender, profile));
    return c.json({ results });
  });

  app.get(detailBase, async (c) => {
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const profileRecord = await repo.findMatchingProfile(organizationId);
    const profile = toOrganizationMatchingProfile(profileRecord, organizationId);
    return c.json(engine.score(tender, profile));
  });

  return app;
}
