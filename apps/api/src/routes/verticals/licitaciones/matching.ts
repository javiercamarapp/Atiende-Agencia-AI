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
import { DEFAULT_TENDERS_LIMIT, MAX_TENDERS_LIMIT, parseOffset, parsePositiveInt, parseTenderListFilter } from "./tender-list-query.ts";

export function licitacionesMatchingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const engine = new MatchingEngine();
  const listBase = "/licitaciones/:propertyId/tenders/matching";
  const detailBase = "/licitaciones/:propertyId/tenders/:tenderId/matching";

  app.use(listBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(detailBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Acotado (paridad3 L-P3-13): antes puntuaba TODAS las convocatorias en cada GET. Ahora paginado (`limit` por omision 50, techo 200,
  // `offset`) y, salvo que se pidan `ids` concretos o `incluirVencidas=true`, solo las de plazo vigente (plazo >= ahora). El puntaje
  // se calcula en vivo sobre la pagina pedida (no se persiste: el perfil puede cambiar).
  app.get(listBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const limit = parsePositiveInt(c.req.query("limit"), DEFAULT_TENDERS_LIMIT, MAX_TENDERS_LIMIT);
    const offset = parseOffset(c.req.query("offset"));
    const filter = parseTenderListFilter((name) => c.req.query(name));
    const incluirVencidas = c.req.query("incluirVencidas") === "true";
    const acotarPorPlazo = filter.ids === undefined && !incluirVencidas && filter.deadlineFrom === undefined;
    const effective = acotarPorPlazo ? { ...filter, deadlineFrom: new Date().toISOString() } : filter;
    const [page, profileRecord] = await Promise.all([repo.listTendersPage(organizationId, { ...effective, limit, offset }), repo.findMatchingProfile(organizationId)]);
    const profile = toOrganizationMatchingProfile(profileRecord, organizationId);
    const results = page.items.map((tender) => engine.score(tender, profile));
    c.header("X-Total-Count", String(page.total));
    if (page.nextOffset !== null) c.header("X-Next-Offset", String(page.nextOffset));
    return c.json({ results });
  });

  app.get(detailBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
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
