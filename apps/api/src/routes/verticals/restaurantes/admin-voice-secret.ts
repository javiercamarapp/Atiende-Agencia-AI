// Rotacion del secreto de voz POR SUCURSAL (ADR-PM-001 §8.2). Reemplaza gradualmente al secreto global
// `VOICE_TOOL_SECRET`: cada sucursal tiene el suyo, se guarda solo como hash (sha256 de un valor aleatorio
// de 256 bits) y el anterior sigue valido una ventana de gracia para rotar sin cortar llamadas en curso.
// El secreto en claro se devuelve UNA sola vez, en esta respuesta; nunca se vuelve a poder leer.
//
// Autorizacion: owner/admin (`STAFF_INVITE_ROLES`), sesion de staff autenticado, sucursal dentro del alcance
// de la membership -- mismo umbral que el resto de la configuracion sensible (admin-config.ts).
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { RestaurantesConfigUnavailableError, STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { hashVoiceSecret } from "./voice-auth.ts";

/** Ventana en la que el secreto anterior sigue siendo valido tras una rotacion. */
export const VOICE_SECRET_ROTATION_GRACE_SECONDS = 60 * 60;

export function restaurantesAdminVoiceSecretRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/config/sucursales/:branchId/voz/secreto";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function resolveBranch(c: Context<CoreAuthHonoEnv>) {
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId") ?? "";
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null && !scope.includes(branchId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");
    const repo = deps.restaurantesRepo(c.get("db"));
    const branch = await repo.findBranchById(organizationId, branchId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return { organizationId, branch, repo };
  }

  app.post(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, branch, repo } = await resolveBranch(c);
    const secret = `vbs_${randomBytes(32).toString("base64url")}`;
    let rotatedAt: string;
    try {
      ({ rotatedAt } = await repo.rotateVoiceBranchSecret(organizationId, branch.propertyId, hashVoiceSecret(secret), secret.slice(-4), VOICE_SECRET_ROTATION_GRACE_SECONDS));
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable("Los secretos de voz por sucursal todavía no están disponibles en esta base de datos.");
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_secreto_voz_rotado", { actorUserId: c.get("userId"), organizationId, branchId: branch.propertyId });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.secreto_voz_rotado",
      entityType: "configuracion",
      entityId: branch.propertyId,
      campo: "secretoVoz",
      antes: null,
      // Nunca el secreto ni su hash: solo el hecho de la rotacion.
      despues: "rotado",
    });
    c.header("Cache-Control", "no-store");
    return c.json({ secret, hint: secret.slice(-4), rotated_at: rotatedAt, previous_valid_for_seconds: VOICE_SECRET_ROTATION_GRACE_SECONDS });
  });

  return app;
}
