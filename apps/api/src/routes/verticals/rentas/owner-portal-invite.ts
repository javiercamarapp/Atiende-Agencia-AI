// Aprovisiona el acceso al portal de propietario -- LA HACE STAFF, nunca el
// propietario (diseño Fase 3 §5). Es la única ruta de ESCRITURA de toda la Fase 3, y es
// deliberadamente de staff: un portal 100% de lectura para el propietario no puede
// arrancar sin que alguien con acceso real (membership real de una organización
// vinculada) certifique primero que el correo pertenece a él.
//
// Vive bajo `CoreAuthHonoEnv` (SÍ usa `requirePropertyMembership`) -- a diferencia de
// owner-portal.ts, esta ruta la ejerce un staff autenticado normal, exactamente el
// mismo mecanismo que el resto de rutas de staff de rentas.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { FINANZAS_LECTURA_ROLES, generateInviteToken } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 días -- vigencia razonable para que staff comparta el link.

export function rentasOwnerPortalInviteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/rentas/:propertyId/owners/:ownerId/portal-invite";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(path, async (c) => {
    // Mismo criterio que "quién puede ver datos financieros del propietario puede
    // invitarlo a verlos" (diseño §5) -- FINANZAS_LECTURA_ROLES ya es la lista de roles
    // que finanzas-statements.ts usa para GET de owner statements.
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const ownerId = c.req.param("ownerId");
    const staffId = c.get("userId");

    // Reutiliza EXACTAMENTE la misma verificación que ya hace finanzas-statements.ts
    // antes de generar/listar statements: el owner debe tener al menos una unidad en
    // ESTA property -- nunca se invita a un id de propietario arbitrario que staff no
    // pueda ya ver por su membership real.
    const owner = await deps.rentasRepo.findOwnerConUnidadesEnProperty(propertyId, ownerId);
    if (!owner) throw Errors.notFound("Propietario no encontrado, o sin ninguna unidad en esta property.");

    const { tokenPlain, tokenHash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    await deps.rentasOwnerPortalRepo.createPortalInvite({ ownerId, tokenHash, expiresAt, createdBy: staffId });

    // El envío por correo real queda fuera de fase (§8, sin proveedor SMTP en el
    // monorepo todavía) -- staff copia/pega este token en el mensaje que le mande al
    // propietario (punto abierto §9-#1). Se devuelve UNA sola vez: nunca se puede
    // recuperar de nuevo tras esta respuesta (solo el hash persiste).
    return c.json({ ownerId, inviteToken: tokenPlain, expiresAt }, 201);
  });

  return app;
}
