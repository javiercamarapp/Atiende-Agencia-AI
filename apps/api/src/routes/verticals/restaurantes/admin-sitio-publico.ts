// R-38 -- "Sitio publico" del panel: marca que el storefront muestra en su portada (titular, eslogan, descripcion, portada, logo y
// redes). owner/admin unicamente (mismo umbral que la configuracion de canal, admin-config.ts); sesion de STAFF autenticado, nunca de
// sistema. La RLS de `restaurantes.storefront_marca` (migracion 042) es la autoridad; `assertVerticalRole` da el mensaje claro.
// Base sin migrar: la lectura devuelve la marca vacia con `disponible: false` y la escritura 503 -- nunca 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MARCA_VACIA, RestaurantesConfigUnavailableError, STAFF_INVITE_ROLES, StorefrontValidationError, validarMarca } from "@atiende/domain-restaurantes";
import type { StorefrontMarca } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const CAMPOS_AUDITADOS = ["titular", "eslogan", "about", "portadaUrl", "logoUrl", "instagramUrl", "facebookUrl", "tiktokUrl"] as const;

export function restaurantesAdminSitioPublicoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/config/sitio-publico";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const marca = await deps.restaurantesRepo(c.get("db")).findStorefrontMarca(c.get("organizationId"));
    c.header("Cache-Control", "no-store");
    // `disponible: false` solo distingue "nunca se guardo" de "la base aun no tiene la migracion": ambos devuelven la marca vacia.
    return c.json({ marca: marca ?? { ...MARCA_VACIA }, guardada: marca !== null });
  });

  app.put(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    let input;
    try {
      input = validarMarca(raw);
    } catch (err) {
      if (err instanceof StorefrontValidationError) throw Errors.validation(err.message);
      throw err;
    }
    const repo = deps.restaurantesRepo(c.get("db"));
    const anterior = await repo.findStorefrontMarca(organizationId);
    let guardada: StorefrontMarca;
    try {
      guardada = await repo.upsertStorefrontMarca(organizationId, input);
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable("El sitio público todavía no se puede editar: falta aplicar una actualización de la base de datos.");
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_sitio_publico_actualizado", { actorUserId: staffId, organizationId });
    // Bitacora (entityType 'configuracion'): un renglon por campo que cambio. Los valores son texto publico de la marca, no PII.
    const previa = anterior ?? MARCA_VACIA;
    for (const campo of CAMPOS_AUDITADOS) {
      if (previa[campo] === guardada[campo]) continue;
      await repo.registrarAuditoria({
        organizationId,
        actorUserId: staffId,
        action: "configuracion.sitio_publico_actualizado",
        entityType: "configuracion",
        entityId: null,
        campo,
        antes: previa[campo],
        despues: guardada[campo],
      });
    }
    return c.json({ marca: guardada, guardada: true });
  });

  return app;
}
