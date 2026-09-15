// Hallazgo de auditoría (severidad ALTA, "alta de organización/staff imposible
// sin SQL"): licitaciones era la única de las 6 verticales, junto con
// restaurantes, en tener necesidad de este flujo y la ÚNICA sin construirlo
// todavía -- port literal del patrón real de
// `apps/api/src/routes/verticals/restaurantes/admin-staff.ts` (ver el
// comentario de cabecera de ese archivo para la decisión de diseño completa:
// el mecanismo -- token con expiración, `core.staff_invite`, función SQL
// `core.accept_staff_invite` -- ya es GENÉRICO desde esa fase, vive en
// `core`/`@atiende/db`/`@atiende/core-auth`/`@atiende/core-authz` -- esta
// ruta solo decide exponerlo para licitaciones, sin tocar ni una línea de
// esos paquetes compartidos). La ruta de ACEPTAR (lado del invitado, sin
// sesión todavía) ya es genérica y vive en `routes/auth.ts::POST
// /auth/accept-invite` -- nada específico de licitaciones ahí tampoco.
//
// Alcance deliberadamente MÁS angosto que restaurantes: licitaciones no tiene
// un rol operable tipo "repartidor" (`GET .../admin/staff/repartidores` no
// tiene equivalente aquí -- ningún consumidor real lo necesita todavía), así
// que este archivo solo trae el CRUD de invitaciones (crear/listar/revocar).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { canInviteStaff } from "@atiende/core-authz";
import type { PlatformRole } from "@atiende/core-tenancy";
import { correoInvitacionStaff, isLicitacionesRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "@atiende/domain-licitaciones";
import type { StaffInviteRow } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

// 7 días — misma vigencia que restaurantes/admin-staff.ts y el portal de
// propietario de rentas.
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

export function licitacionesAdminStaffRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const collectionPath = "/v1/licitaciones/:propertyId/admin/staff/invitaciones";
  const itemPath = "/v1/licitaciones/:propertyId/admin/staff/invitaciones/:inviteId";

  app.use(collectionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateInviteBody>(c.req.raw, 2 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isLicitacionesRole(raw.verticalRole)) {
      throw Errors.validation("verticalRole inválido — se esperaba uno de: owner, admin, analyst, writer, reviewer, viewer.");
    }
    const email = raw.email.trim().toLowerCase();
    const verticalRole = raw.verticalRole;
    const targetPlatformRole: PlatformRole = PLATFORM_ROLE_BY_VERTICAL_ROLE[verticalRole];

    // Segunda capa (además de `assertVerticalRole(STAFF_INVITE_ROLES)` de arriba):
    // jerarquía real de `core-authz`, genérica a las 6 verticales — un admin nunca
    // da de alta a otro owner, aunque "admin" sí esté en STAFF_INVITE_ROLES.
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

    // El invitado NUNCA gana un alcance de properties más amplio que el de quien
    // invita -- mismo criterio de "nunca ensanchar el alcance" que
    // `resolveEffectivePropertyIds` de restaurantes; licitaciones no tiene
    // selector de sucursal en esta ruta (siempre hereda el alcance completo de
    // quien invita), así que se resuelve inline en vez de reusar ese helper.
    const memberships = await deps.coreRepo.findMembershipsByUserId(staffId);
    const inviterMembership = memberships.find((m) => m.organizationId === organizationId);
    const verifiedPropertyId = c.req.param("propertyId") ?? "";
    const propertyIds: readonly string[] | null = inviterMembership ? inviterMembership.propertyIds : [verifiedPropertyId];

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

    // Correo real (Resend, mismo canal que `email-dispatch.ts` de este vertical)
    // con el enlace de activación ya armado -- best-effort: un fallo al encolar
    // el correo NUNCA debe revertir la invitación que sí quedó creada. El token
    // se sigue devolviendo UNA sola vez en la respuesta HTTP (solo el hash
    // persiste) por si quien invita prefiere compartirlo por otro medio.
    try {
      const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
      const correo = correoInvitacionStaff({
        email,
        verticalRole,
        acceptUrl,
        expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(expiresAt)),
      });
      await deps.licitacionesRepo(c.get("db")).enqueueMessagingOutbox(organizationId, "email", "staff.invite", `staff-invite:${invite.id}`, {
        to: email,
        subject: correo.asunto,
        html: correo.html,
        text: correo.texto,
      });
    } catch (err) {
      console.error("licitaciones/admin-staff: best-effort staff invite email enqueue failed:", err);
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
