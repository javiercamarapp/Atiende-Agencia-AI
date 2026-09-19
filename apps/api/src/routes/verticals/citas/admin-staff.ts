// Fase 12 citas — ALTA Y GESTIÓN DE CUENTAS DE STAFF (hallazgo de auditoría CRÍTICO/
// ALTO: "citas define 3 roles de plataforma pero no los aplica en NINGUNA capa").
// Verificado contra el código real: `roles.ts` (CITAS_ROLES/PLATFORM_ROLE_BY_
// VERTICAL_ROLE) se definió en Fase 1 pero NINGUNA ruta lo importaba — no existía
// ni una sola forma de PRODUCIR una fila `core.membership` para citas (alta de
// organización/staff quedaba fuera de las 11 fases construidas). El mecanismo
// subyacente (token con expiración, `core.staff_invite`, la función SQL
// `core.accept_staff_invite`) es GENÉRICO y ya está construido (ver
// packages/db/migrations/0002_staff_invite_schema.sql) — restaurantes es la única
// vertical que hasta esta rama lo exponía del lado del INVITADOR (ver
// apps/api/src/routes/verticals/restaurantes/admin-staff.ts, patrón de referencia
// citado explícitamente para este cambio). Este archivo es el mismo patrón, letra
// por letra, para citas: crear/listar/revocar una invitación, gateado por
// `STAFF_INVITE_ROLES` (owner/admin) de domain-citas/src/roles.ts — sin la
// superficie de "repartidores" de restaurantes (citas no tiene ese concepto).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { canInviteStaff } from "@atiende/core-authz";
import type { PlatformRole } from "@atiende/core-tenancy";
import { correoInvitacionStaff, isCitasRole, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "@atiende/domain-citas";
import { MembershipRoleUpdateError } from "@atiende/db";
import type { OrganizationMemberWithRoleRow, StaffInviteRow } from "@atiende/db";
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

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): mismo hueco real que
// restaurantes tenía antes de esta pasada (ver
// packages/db/migrations/0007_update_membership_role.sql para el hallazgo
// completo) — `POST collectionPath` de arriba solo fija el rol AL INVITAR, ningún
// endpoint cambiaba el de un staff YA ACEPTADO. Port EXACTO de
// restaurantes/admin-staff.ts (leído primero como plantilla) sobre
// `CITAS_ROLES`/`isCitasRole` en vez de las de restaurantes.
function serializeMemberWithRole(member: OrganizationMemberWithRoleRow) {
  return {
    id: member.userId,
    email: member.email,
    fullName: member.fullName,
    verticalRole: member.verticalRole,
    propertyIds: member.propertyIds,
  };
}

interface UpdateMemberRoleBody {
  readonly verticalRole?: unknown;
}

export function citasAdminStaffRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  // Mismo prefijo `/v1/citas/properties/:propertyId/...` que el resto del panel de
  // citas (admin.ts/appointments-lifecycle.ts) — a diferencia de restaurantes
  // (`/v1/restaurantes/:propertyId/admin/...`), citas ya estableció su propia
  // convención de rutas desde Fase 5; este archivo la sigue, no la de restaurantes.
  const collectionPath = "/v1/citas/properties/:propertyId/admin/staff/invitaciones";
  const itemPath = "/v1/citas/properties/:propertyId/admin/staff/invitaciones/:inviteId";
  const miembrosPath = "/v1/citas/properties/:propertyId/admin/staff/miembros";
  const miembroItemPath = "/v1/citas/properties/:propertyId/admin/staff/miembros/:userId";

  app.use(collectionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(miembrosPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(miembroItemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateInviteBody>(c.req.raw, 2 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isCitasRole(raw.verticalRole)) {
      throw Errors.validation(`verticalRole inválido — se esperaba uno de: owner, admin, staff.`);
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
    //
    // Hallazgo de seguridad (Fase 3 caller-binding, ver `packages/db/migrations/
    // 0017_caller_binding_fase3.sql`): ANTES, este lookup por correo pasaba por
    // `deps.coreRepo` (sesión de sistema fija, `core.find_staff_by_email`/
    // `find_memberships_by_user_id` sin atar a `auth.uid()`) -- ahora esas dos
    // funciones son de solo-sistema, así que aquí se usa `deps.coreStaffRepo(c.get
    // ("db"))` (sesión REAL por-request, `auth.uid()` = este admin autenticado) +
    // las funciones nuevas `core.find_staff_for_org_admin`/`core.is_staff_org_
    // member_for_org_admin`, que exigen DENTRO de la función que el caller sea
    // owner/admin de `organizationId` -- defensa en profundidad real, no solo el
    // `assertVerticalRole(STAFF_INVITE_ROLES)` de arriba. `existingStaff` nunca trae
    // `passwordHash` (a diferencia del `StaffUserRow` que devolvía `findStaffByEmail`).
    // NOTA: `inviterMemberships` de abajo (self-lookup, `staffId = c.get("userId")`)
    // se queda en `deps.coreRepo` sin cambio -- corre en sesión de sistema
    // (`auth.uid()` null) hoy y sigue siendo válido bajo el guard nuevo.
    const staffRepo = deps.coreStaffRepo(c.get("db"));
    const existingStaff = await staffRepo.findStaffForOrgAdmin(organizationId, email);
    if (existingStaff) {
      const alreadyMember = await staffRepo.isStaffOrgMember(organizationId, existingStaff.id);
      if (alreadyMember) {
        throw Errors.conflict("Ese correo ya es staff de esta organización.");
      }
    }

    // El invitado NUNCA gana un alcance de properties más amplio que el de quien
    // invita — mismo criterio de "nunca ensanchar el alcance" que
    // resolveEffectivePropertyIds ya aplica en restaurantes/admin-scope.ts. A
    // diferencia de `c.get("propertyIds")` (que `requirePropertyMembership` fija a
    // `[propertyId]` de la URL, siempre UNA sola sucursal), se resuelve aquí la
    // membership REAL completa del invitador — un owner/admin con acceso a varias
    // sucursales invita con ese mismo alcance real, no acotado a la sucursal desde
    // la que abrió el panel.
    const inviterMemberships = await deps.coreRepo.findMembershipsByUserId(staffId);
    const inviterMembership = inviterMemberships.find((m) => m.organizationId === organizationId);
    const propertyIds: readonly string[] | null = inviterMembership ? inviterMembership.propertyIds : c.get("propertyIds");

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

    // Mismo criterio "honesto" que restaurantes/admin-staff.ts: el correo real vía
    // `citas.email_outbox` (email-dispatch.ts drena el envío real) es best-effort —
    // un fallo al encolarlo NUNCA debe revertir la invitación que sí quedó creada.
    // El token se sigue devolviendo UNA sola vez en la respuesta HTTP.
    try {
      const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
      const correo = correoInvitacionStaff({
        email,
        verticalRole,
        acceptUrl,
        expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(expiresAt)),
      });
      await deps.citasRepo(c.get("db")).enqueueMessagingOutbox(organizationId, "email", "staff.invite", `staff-invite:${invite.id}`, {
        to: email,
        subject: correo.asunto,
        html: correo.html,
        text: correo.texto,
      });
    } catch (err) {
      console.error("citas admin-staff: best-effort staff invite email enqueue failed:", err);
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

  app.get(miembrosPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const members = await deps.coreStaffRepo(c.get("db")).listOrgMembers(organizationId);
    return c.json({ miembros: members.map(serializeMemberWithRole) });
  });

  // Cambia el `verticalRole`/`platformRole` de un staff YA ACEPTADO — mismas dos
  // capas de autorización que `POST collectionPath` (invitar): `assertVerticalRole`
  // + `canInviteStaff` aplicado dos veces (rol actual del target y rol nuevo). La
  // AUTORIDAD real es `core.update_membership_role` (`security definer`, ver la
  // migración) — ver el comentario completo en restaurantes/admin-staff.ts.
  app.patch(miembroItemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const callerUserId = c.get("userId");
    const targetUserId = c.req.param("userId");

    if (targetUserId === callerUserId) throw Errors.validation("No puedes cambiar tu propio rol.");

    const raw = await readJsonCapped<UpdateMemberRoleBody>(c.req.raw, 1 * 1024);
    if (typeof raw.verticalRole !== "string" || !isCitasRole(raw.verticalRole)) {
      throw Errors.validation(`verticalRole inválido — se esperaba uno de: owner, admin, staff.`);
    }
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
      return c.json(serializeMemberWithRole(updated));
    } catch (err) {
      if (err instanceof MembershipRoleUpdateError) throw Errors.forbidden(err.message);
      throw err;
    }
  });

  return app;
}
