// Rn-20 -- gestion del staff de rentas: invitar, cambiar el rol y dar de baja (rentas era la unica vertical sin
// `admin-staff.ts`; sin esto no se podia dar de alta a limpieza, al contador ni a un operador, y el modulo de limpieza
// no tenia a quien asignar tareas). Port del patron de apps/api/src/routes/verticals/restaurantes/admin-staff.ts (el
// mas completo: invitaciones + miembros + cambio de rol + baja): el mecanismo (token con expiracion,
// `core.staff_invite`, `core.accept_staff_invite`, `core.update_membership_role`, `core.remove_membership`) es
// GENERICO y vive en core/@atiende/db/@atiende/core-auth/@atiende/core-authz; esta ruta solo lo expone para rentas con
// su propia lista de roles (`STAFF_INVITE_ROLES`: solo admin_gestora) y su bitacora (`rentas.audit_log`,
// entity_type='membership', reservado desde la migracion 021 sin caller hasta hoy). Aceptar la invitacion (lado del
// invitado, sin sesion todavia) ya es generico: `routes/auth.ts::POST /auth/accept-invite`.
//
//   POST   /v1/rentas/:propertyId/admin/staff/invitaciones
//   GET    /v1/rentas/:propertyId/admin/staff/invitaciones
//   DELETE /v1/rentas/:propertyId/admin/staff/invitaciones/:inviteId
//   GET    /v1/rentas/:propertyId/admin/staff/miembros
//   PATCH  /v1/rentas/:propertyId/admin/staff/miembros/:userId     (cambia el verticalRole)
//   DELETE /v1/rentas/:propertyId/admin/staff/miembros/:userId     (baja)
//
// No hay migracion nueva: `core.update_membership_role` y `core.remove_membership` ya son las autoridades reales y
// reaplican la jerarquia dentro de SQL; las capas de TypeScript de abajo son primer filtro y mejor mensaje.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { canInviteStaff } from "@atiende/core-authz";
import type { PlatformRole } from "@atiende/core-tenancy";
import { correoInvitacionStaff, isRentasVerticalRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, RENTAS_VERTICAL_ROLES, STAFF_INVITE_ROLES, tryEnqueueStaffInviteEmail } from "@atiende/domain-rentas";
import { MembershipRemovalError, MembershipRemovalUnavailableError, MembershipRoleUpdateError } from "@atiende/db";
import type { OrganizationMemberWithRoleRow, StaffInviteRow } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

// 7 dias -- misma vigencia que las demas verticales.
const STAFF_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MENSAJE_ROL_INVALIDO = `verticalRole inválido — se esperaba uno de: ${RENTAS_VERTICAL_ROLES.join(", ")}.`;

/** Enmascara el correo del invitado antes de guardarlo en la bitacora (append-only e imborrable): conserva el primer
 *  caracter y el dominio, nunca el correo completo (mismo criterio que restaurantes/admin-staff.ts). */
function enmascararCorreoInvitado(email: string): string {
  const arroba = email.indexOf("@");
  if (arroba <= 0) return "***";
  return `${email[0]}***@${email.slice(arroba + 1)}`;
}

interface CreateInviteBody {
  readonly email?: unknown;
  readonly verticalRole?: unknown;
}

interface UpdateMemberRoleBody {
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

function serializeMemberWithRole(member: OrganizationMemberWithRoleRow) {
  return {
    id: member.userId,
    email: member.email,
    fullName: member.fullName,
    verticalRole: member.verticalRole,
    propertyIds: member.propertyIds,
  };
}

export function rentasAdminStaffRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const collectionPath = "/v1/rentas/:propertyId/admin/staff/invitaciones";
  const itemPath = "/v1/rentas/:propertyId/admin/staff/invitaciones/:inviteId";
  const miembrosPath = "/v1/rentas/:propertyId/admin/staff/miembros";
  const miembroItemPath = "/v1/rentas/:propertyId/admin/staff/miembros/:userId";

  for (const path of [collectionPath, itemPath, miembrosPath, miembroItemPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  app.post(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateInviteBody>(c.req.raw, 2 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isRentasVerticalRole(raw.verticalRole)) throw Errors.validation(MENSAJE_ROL_INVALIDO);
    const email = raw.email.trim().toLowerCase();
    const verticalRole = raw.verticalRole;
    const targetPlatformRole: PlatformRole = PLATFORM_ROLE_BY_VERTICAL_ROLE[verticalRole];

    // Segunda capa (ademas de `assertVerticalRole(STAFF_INVITE_ROLES)`): jerarquia real de `core-authz`, generica a las 6
    // verticales -- quien invita nunca da de alta a alguien por encima de su propio rango.
    const inviterPlatformRole = c.get("platformRole");
    if (!inviterPlatformRole || !canInviteStaff(inviterPlatformRole, targetPlatformRole)) throw Errors.staffInviteRolInsuficiente();

    // Ya es staff de esta organizacion -> conflicto explicito. Lookup con la sesion REAL por-request (`auth.uid()` = este
    // admin): `core.find_staff_for_org_admin`/`core.is_staff_org_member_for_org_admin` exigen DENTRO de la funcion que el
    // caller sea owner/admin de la organizacion (caller-binding Fase 3).
    const staffRepo = deps.coreStaffRepo(c.get("db"));
    const existingStaff = await staffRepo.findStaffForOrgAdmin(organizationId, email);
    if (existingStaff && (await staffRepo.isStaffOrgMember(organizationId, existingStaff.id))) {
      throw Errors.conflict("Ese correo ya es staff de esta organización.");
    }

    // El invitado NUNCA gana un alcance de properties mas amplio que el de quien invita.
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

    // Correo real (outbox de rentas) con el enlace ya armado -- best-effort bajo SAVEPOINT: un fallo al encolar NUNCA
    // revierte la invitacion ya creada. El token se devuelve UNA sola vez en la respuesta HTTP (solo el hash persiste).
    const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
    const correo = correoInvitacionStaff({
      email,
      verticalRole,
      acceptUrl,
      expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(expiresAt)),
    });
    await tryEnqueueStaffInviteEmail(deps.rentasRepo(c.get("db")), c.get("db"), verifiedPropertyId, organizationId, invite.id, email, correo);

    logEvent(c, "info", "rentas_admin_staff_invitado", { actorUserId: staffId, organizationId, propertyIds, inviteId: invite.id, invitedEmail: email, verticalRole });

    // Bitacora de membership. Correo ENMASCARADO: dato minimo para reconocer a quien se invito, nunca completo en una
    // tabla append-only que nadie puede borrar (ARCO).
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "staff.invitado",
      entityType: "membership",
      entityId: invite.id,
      campo: "email,verticalRole",
      antes: null,
      despues: `${enmascararCorreoInvitado(email)} (${verticalRole})`,
    });

    return c.json({ ...serializeInvite(invite), inviteToken: tokenPlain }, 201);
  });

  app.get(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const invites = await deps.coreStaffRepo(c.get("db")).listPendingStaffInvites(c.get("organizationId"));
    return c.json({ invitations: invites.map(serializeInvite) });
  });

  app.delete(itemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const inviteId = c.req.param("inviteId");
    const revoked = await deps.coreStaffRepo(c.get("db")).revokeStaffInvite(inviteId, organizationId);
    if (!revoked) throw Errors.notFound("Invitación no encontrada, ya fue usada, o ya estaba revocada.");
    logEvent(c, "info", "rentas_admin_staff_invitacion_revocada", { actorUserId: c.get("userId"), organizationId, inviteId });
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "staff.invitacion_revocada",
      entityType: "membership",
      entityId: inviteId,
      campo: null,
      antes: null,
      despues: null,
    });
    return c.json({ ok: true });
  });

  app.get(miembrosPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const members = await deps.coreStaffRepo(c.get("db")).listOrgMembers(c.get("organizationId"));
    return c.json({ miembros: members.map(serializeMemberWithRole) });
  });

  // Cambia el `verticalRole` (y su `platformRole` mapeado) de un staff YA ACEPTADO. Dos capas de TypeScript (STAFF_INVITE_ROLES
  // y `canInviteStaff` al rol ACTUAL del target y al NUEVO) y la autoridad real en `core.update_membership_role` (security
  // definer, reaplica la jerarquia y bloquea el auto-cambio).
  app.patch(miembroItemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const callerUserId = c.get("userId");
    const targetUserId = c.req.param("userId");

    if (targetUserId === callerUserId) throw Errors.validation("No puedes cambiar tu propio rol.");

    const raw = await readJsonCapped<UpdateMemberRoleBody>(c.req.raw, 1 * 1024);
    if (typeof raw.verticalRole !== "string" || !isRentasVerticalRole(raw.verticalRole)) throw Errors.validation(MENSAJE_ROL_INVALIDO);
    const newVerticalRole = raw.verticalRole;
    const newPlatformRole: PlatformRole = PLATFORM_ROLE_BY_VERTICAL_ROLE[newVerticalRole];

    const members = await deps.coreStaffRepo(c.get("db")).listOrgMembers(organizationId);
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw Errors.notFound("Ese staff no pertenece a esta organización.");

    const callerPlatformRole = c.get("platformRole");
    if (!callerPlatformRole || !canInviteStaff(callerPlatformRole, target.platformRole) || !canInviteStaff(callerPlatformRole, newPlatformRole)) {
      throw Errors.staffRoleChangeRolInsuficiente();
    }

    try {
      const updated = await deps.coreStaffRepo(c.get("db")).updateMemberVerticalRole(organizationId, targetUserId, newPlatformRole, newVerticalRole);
      // Nunca el correo del target (ya visible en el listado): solo el id de usuario y el rol antes/despues.
      await deps.rentasRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: callerUserId,
        action: "staff.rol_actualizado",
        entityType: "membership",
        entityId: targetUserId,
        campo: "verticalRole",
        antes: target.verticalRole,
        despues: newVerticalRole,
      });
      return c.json(serializeMemberWithRole(updated));
    } catch (err) {
      if (err instanceof MembershipRoleUpdateError) throw Errors.forbidden(err.message);
      throw err;
    }
  });

  // Baja de un miembro YA ACEPTADO. Mismo umbral que el cambio de rol. Casos limite: nunca auto-baja y nunca dejar la
  // organizacion sin ningun admin_gestora. Autoridad real: `core.remove_membership`; `MembershipRemovalUnavailableError`
  // (SQLSTATE 42883, migracion 0024 sin aplicar) -> 503 honesto, nunca un 500.
  app.delete(miembroItemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const callerUserId = c.get("userId");
    const targetUserId = c.req.param("userId");

    if (targetUserId === callerUserId) throw Errors.staffRemovalAutoBaja();

    const members = await deps.coreStaffRepo(c.get("db")).listOrgMembers(organizationId);
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw Errors.notFound("Ese staff no pertenece a esta organización.");

    const callerPlatformRole = c.get("platformRole");
    if (!callerPlatformRole || !canInviteStaff(callerPlatformRole, target.platformRole)) throw Errors.staffRemovalRolInsuficiente();

    if (target.verticalRole === "admin_gestora" && members.filter((m) => m.verticalRole === "admin_gestora").length <= 1) {
      throw Errors.staffRemovalSinOwner();
    }

    try {
      await deps.coreStaffRepo(c.get("db")).removeMembership(organizationId, targetUserId);
    } catch (err) {
      if (err instanceof MembershipRemovalError) throw Errors.forbidden(err.message);
      if (err instanceof MembershipRemovalUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    logEvent(c, "info", "rentas_admin_staff_dado_de_baja", { actorUserId: callerUserId, organizationId, targetUserId });
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: callerUserId,
      action: "staff.baja",
      entityType: "membership",
      entityId: targetUserId,
      campo: "verticalRole",
      antes: target.verticalRole,
      despues: null,
    });
    return c.json({ ok: true });
  });

  return app;
}
