// Hallazgo de auditoría (severidad ALTA, "Alta de organización/staff imposible
// sin SQL") — despachos era la única vertical (junto con las otras 4 fuera de
// restaurantes) sin ninguna ruta HTTP para dar de alta staff nuevo. El
// mecanismo (token con expiración, `core.staff_invite`, función SQL
// `core.accept_staff_invite`) ya es GENÉRICO desde que restaurantes lo
// construyó (packages/db/migrations/0002_staff_invite_schema.sql,
// `@atiende/db::CoreRepository`/`CoreStaffRepository`,
// `@atiende/core-auth::generateInviteToken`, `@atiende/core-authz::canInviteStaff`)
// — este archivo es el port EXACTO de
// apps/api/src/routes/verticals/restaurantes/admin-staff.ts (leído primero
// como plantilla) sobre `DESPACHOS_ROLES`/`STAFF_INVITE_ROLES`
// (@atiende/domain-despachos/roles.ts) en vez de las de restaurantes.
//
// La ruta HTTP de ACEPTAR (lado del invitado, sin sesión todavía) es genérica
// y ya vive en `routes/auth.ts::POST /auth/accept-invite` — no hay nada
// específico de despachos ahí.
//
// A diferencia de restaurantes (organización con múltiples sucursales/branches
// resueltas aparte, `resolveEffectivePropertyIds`), las rutas de despachos ya
// están todas ancladas a un solo `:propertyId` en la URL (mismo patrón que
// declaraciones.ts/nomina.ts/cobranza.ts de este mismo directorio) — el
// invitado se limita a ESE property, nunca a uno más amplio que el que el
// invitador ya tiene abierto en el panel.
//
// Sin la sección "repartidores" de restaurantes: despachos no tiene un rol
// análogo con selector propio en otra ruta — `DESPACHOS_ROLES` (admin/
// contador/auditor/readonly) se resuelve por completo aquí.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { canInviteStaff } from "@atiende/core-authz";
import type { PlatformRole } from "@atiende/core-tenancy";
import { correoInvitacionStaff, isDespachosRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "@atiende/domain-despachos";
import type { StaffInviteRow } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

// 7 días — misma vigencia que restaurantes/admin-staff.ts::STAFF_INVITE_TTL_MS.
const STAFF_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CreateInviteBody {
  readonly email?: unknown;
  readonly verticalRole?: unknown;
}

function serializeInvite(invite: StaffInviteRow) {
  return {
    id: invite.id,
    email: invite.email,
    verticalRole: invite.verticalRole,
    propertyIds: invite.propertyIds,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  };
}

export function despachosAdminStaffRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const collectionPath = "/despachos/:propertyId/admin/staff/invitaciones";
  const itemPath = "/despachos/:propertyId/admin/staff/invitaciones/:inviteId";

  app.use(collectionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateInviteBody>(c.req.raw, 2 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isDespachosRole(raw.verticalRole)) {
      throw Errors.validation(`verticalRole inválido — se esperaba uno de: admin, contador, auditor, readonly.`);
    }
    const email = raw.email.trim().toLowerCase();
    const verticalRole = raw.verticalRole;
    const targetPlatformRole: PlatformRole = PLATFORM_ROLE_BY_VERTICAL_ROLE[verticalRole];

    // Segunda capa (además de `assertVerticalRole(STAFF_INVITE_ROLES)` de arriba):
    // jerarquía real de `core-authz`, genérica a las 6 verticales.
    const inviterPlatformRole = c.get("platformRole");
    if (!inviterPlatformRole || !canInviteStaff(inviterPlatformRole, targetPlatformRole)) {
      throw Errors.staffInviteRolInsuficiente();
    }

    // Ya es staff de esta organización -> conflicto explícito en vez de una
    // invitación fantasma que nunca podría "vincularse" dos veces al mismo membership.
    const existingStaff = await deps.coreRepo.findStaffByEmail(email);
    if (existingStaff) {
      const memberships = await deps.coreRepo.findMembershipsByUserId(existingStaff.id);
      if (memberships.some((m) => m.organizationId === organizationId)) {
        throw Errors.conflict("Ese correo ya es staff de esta organización.");
      }
    }

    // El invitado se limita al property que el invitador ya tiene abierto en el
    // panel — nunca uno más amplio (mismo criterio de "nunca ensanchar el
    // alcance" que restaurantes/admin-staff.ts aplica con
    // `resolveEffectivePropertyIds`; aquí no hace falta ese resolver porque
    // TODAS las rutas de despachos ya anclan a un solo `:propertyId`, ver
    // comentario de cabecera).
    const propertyIds = [propertyId];

    const { tokenPlain, tokenHash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + STAFF_INVITE_TTL_MS).toISOString();

    const invite = await deps.coreStaffRepo(c.get("db")).createStaffInvite({
      email,
      organizationId,
      platformRole: targetPlatformRole,
      verticalRole,
      propertyIds,
      tokenHash,
      invitedBy: staffId,
      expiresAt,
    });

    // Correo real vía `despachos.messaging_outbox` (channel='email',
    // @atiende/domain-despachos::email-dispatch.ts drena el envío real) con el
    // enlace de activación ya armado — best-effort: un fallo al encolar el
    // correo NUNCA debe revertir la invitación que sí quedó creada. El token
    // se sigue devolviendo UNA sola vez en la respuesta HTTP (solo el hash
    // persiste, nunca se puede recuperar de nuevo) por si quien invita
    // prefiere compartirlo por otro medio.
    try {
      const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
      const correo = correoInvitacionStaff({
        email,
        verticalRole,
        acceptUrl,
        expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(expiresAt)),
      });
      await deps.despachosRepo(c.get("db")).enqueueMessagingOutbox(organizationId, "email", "staff.invite", `staff-invite:${invite.id}`, {
        to: email,
        subject: correo.asunto,
        html: correo.html,
        text: correo.texto,
      });
    } catch (err) {
      console.error("despachos admin-staff: best-effort staff invite email enqueue failed:", err);
    }

    return c.json({ ...serializeInvite(invite), inviteToken: tokenPlain }, 201);
  });

  app.get(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const invites = await deps.coreStaffRepo(c.get("db")).listPendingStaffInvites(organizationId);
    return c.json({ invitations: invites.map(serializeInvite) });
  });

  app.delete(itemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const inviteId = c.req.param("inviteId");
    const revoked = await deps.coreStaffRepo(c.get("db")).revokeStaffInvite(inviteId, organizationId);
    if (!revoked) throw Errors.notFound("Invitación no encontrada, ya fue usada, o ya estaba revocada.");
    return c.json({ ok: true });
  });

  return app;
}
