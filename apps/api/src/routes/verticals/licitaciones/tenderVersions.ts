// Fase 5 pieza 2 — licitacionesTenderVersionsRoutes: expone por HTTP el
// historial de versiones de convocatoria + diff + cascada de invalidación
// (REQ-017/041/151..155, ver domain-licitaciones/src/tender-version-registry.ts).
// Mismo patrón de montaje/roles que goNoGo.ts/matching.ts: lectura abierta a
// cualquier miembro de la organización, escritura (recompute/acknowledge)
// restringida a WRITE_ROLES.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesTenderVersionsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const versionsBase = "/licitaciones/:propertyId/tenders/:tenderId/versions";
  const recomputeBase = "/licitaciones/:propertyId/tenders/:tenderId/versions/recompute";
  const notificationsBase = "/licitaciones/:propertyId/tender-change-notifications";
  const acknowledgeBase = "/licitaciones/:propertyId/tender-change-notifications/:notificationId/acknowledge";

  app.use(versionsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(recomputeBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(notificationsBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(acknowledgeBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Historial COMPLETO (REQ-153), más antigua primero -- cada versión trae su
  // `diff` ya calculado contra la anterior (sin_cambio/modificado/nuevo/
  // eliminado por campo y por requisito, REQ-017).
  app.get(versionsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const versions = await repo.listTenderVersions(organizationId, tenderId);
    return c.json({ versions });
  });

  // Fuerza un recálculo del snapshot actual (bases + requisitos vigentes)
  // contra la última versión persistida -- útil después de cargar un acta de
  // junta/anexo por un camino que no sea `requirements/extract`
  // (technicalProposal.ts ya lo dispara automáticamente ahí, REQ-041) o para
  // que un reviewer confirme "ya no hay cambios pendientes" tras revisar uno.
  // Idempotente (REQ-154): si nada cambió, `created: false` y ningún efecto
  // secundario nuevo.
  app.post(recomputeBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    const result = await repo.recordTenderVersion(organizationId, tenderId, actorId);
    return c.json(result, result.created ? 201 : 200);
  });

  // Bandeja de notificaciones de cambio de convocatoria (REQ-151/155),
  // dirigida a los roles responsables (`WRITE_ROLES`) -- sin canal de envío
  // real, se consulta aquí. `?tenderId=` filtra a una sola convocatoria.
  app.get(notificationsBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.query("tenderId");
    const notifications = await repo.listTenderChangeNotifications(organizationId, tenderId);
    return c.json({ notifications });
  });

  app.post(acknowledgeBase, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const notificationId = c.req.param("notificationId");
    try {
      const notification = await repo.acknowledgeTenderChangeNotification(organizationId, notificationId, actorId);
      return c.json(notification);
    } catch {
      throw Errors.notFound("Notificación no encontrada.");
    }
  });

  return app;
}
