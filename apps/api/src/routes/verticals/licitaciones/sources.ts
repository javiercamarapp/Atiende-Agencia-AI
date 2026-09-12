// Fase 5 pieza 1 — licitacionesSourcesRoutes: expone por HTTP el andamiaje de
// ingesta (REQ-004/005/146..150, ver diseño de la tarea). Todo de SOLO
// LECTURA -- el único camino de escritura de `source_run` sigue siendo
// interno (`LicitacionesRepository.upsertTenderManual` registra su propia
// corrida automáticamente, ver postgres-repository.ts/in-memory-repository.ts);
// esta ruta nunca deja que un cliente inserte una corrida a mano, para que
// `source_run` siga siendo evidencia real de una operación que sí ocurrió,
// nunca una afirmación del cliente sin verificar.
//
// Mismo criterio de roles que matching.ts: ver el estado de las fuentes no es
// una decisión, cualquier miembro de la organización (incluido "viewer")
// puede leerlo.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { LICITACIONES_CONNECTOR_REGISTRY, isSourceConnectorId } from "@atiende/domain-licitaciones";
import type { SourceConnectorId } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesSourcesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/sources";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/runs`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/freshness`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Registro único de conectores (REQ-004): identidad, cadencia declarada
  // (REQ-146) y verificación puntual (REQ-150) de cada fuente -- constante de
  // dominio, no depende de ninguna organización ni de la base de datos.
  app.get(base, (c) => {
    return c.json({ connectors: LICITACIONES_CONNECTOR_REGISTRY.all() });
  });

  app.get(`${base}/runs`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const sourceParam = c.req.query("source");
    let source: SourceConnectorId | undefined;
    if (sourceParam !== undefined) {
      if (!isSourceConnectorId(sourceParam)) throw Errors.validation(`source: "${sourceParam}" no es un conector registrado.`);
      source = sourceParam;
    }
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw Errors.validation("limit: se esperaba un entero positivo.");
    const runs = await repo.listSourceRuns(organizationId, { source, limit });
    return c.json({ runs });
  });

  // REQ-149: frescura/obsolescencia por fuente, SIEMPRE con las 6 fuentes
  // registradas (incluidas las que nunca corrieron -- `stale: true`
  // explícito, nunca omitidas de la respuesta).
  app.get(`${base}/freshness`, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const freshness = await repo.sourceFreshness(organizationId);
    return c.json({ freshness });
  });

  return app;
}
