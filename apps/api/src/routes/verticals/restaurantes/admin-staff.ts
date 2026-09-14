// Fase 10 restaurantes — ALTA Y GESTIÓN DE CUENTAS DE STAFF (gap real detectado
// durante la Fase 8 mientras se construía el rol "repartidor", ver
// `domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES`): hasta esta fase, ninguna
// vertical de atiende-fusion tenía forma de dar de alta staff ADICIONAL desde el
// producto — el alta original de una organización es manual (seed/consola), y
// `core.staff_user.created_via` ya admitía el valor 'invite' desde
// `migrations/0001_core_schema.sql` sin que NINGÚN método lo produjera todavía (el
// propio comentario de esa migración lo declaraba fuera de alcance: "Escritura de
// gestión (crear org, invitar staff) queda para las rutas núcleo... fuera del
// alcance de esta migración").
//
// DECISIÓN DE DISEÑO (pedida explícitamente): el mecanismo (token con expiración,
// `core.staff_invite`, función SQL `core.accept_staff_invite`) es GENÉRICO — vive en
// `core` (`packages/db/migrations/0002_staff_invite_schema.sql`) y en los paquetes
// compartidos (`@atiende/db::CoreRepository`/`CoreStaffRepository`,
// `@atiende/core-auth::generateInviteToken`, `@atiende/core-authz::canInviteStaff`),
// exactamente como pide el gap: "si el mecanismo correcto es genérico... constrúyelo
// en el paquete compartido correspondiente". La ruta HTTP de ACEPTAR (lado del
// invitado, sin sesión todavía) también es genérica y ya vive en
// `routes/auth.ts::POST /auth/accept-invite` — no hay nada específico de
// restaurantes ahí, es el mismo JWT/login de siempre.
//
// Lo único que este archivo expone ÚNICAMENTE para restaurantes (por instrucción
// explícita de esta fase, "en esta pasada") es el lado del INVITADOR — crear/listar/
// revocar una invitación —, que SÍ necesita contexto de vertical concreto para su
// primer filtro de autorización (`STAFF_INVITE_ROLES` de domain-restaurantes: solo
// owner/admin de RESTAURANTES invitan, nunca "staff"/"repartidor"). Las otras 5
// verticales podrán exponer el mismo archivo (mismo patrón que
// `admin-branches.ts`/`admin-kpis.ts`) con su propia lista `X_STAFF_INVITE_ROLES`
// sin tocar ni una línea de `core`/`core-auth`/`core-authz` — el trabajo de fondo ya
// quedó hecho, esta fase solo decide no exponerlo TODAVÍA para no abrir superficie
// HTTP sin probarla en las otras 5.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership, generateInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { canInviteStaff } from "@atiende/core-authz";
import type { PlatformRole } from "@atiende/core-tenancy";
import { isRestaurantesRole, MANAGER_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import type { OrganizationMemberRow, StaffInviteRow } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

// 7 días — misma vigencia que el portal de propietario de rentas
// (`rentasOwnerPortalInviteRoutes::INVITE_TTL_MS`), razonable para que quien invita
// comparta el link sin presión y sin dejarlo abierto indefinidamente.
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

// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI"): un miembro YA ACEPTADO (`core.membership`), a diferencia de
// `serializeInvite` de arriba (una invitación PENDIENTE, sin `userId` real todavía) —
// esto es justo lo que el selector de `PATCH .../admin/orders/:orderId/assign-
// repartidor` (admin-orders.ts) necesita: a QUIÉN se le puede despachar un pedido.
function serializeMember(member: OrganizationMemberRow) {
  return {
    id: member.userId,
    email: member.email,
    fullName: member.fullName,
    propertyIds: member.propertyIds,
  };
}

export function restaurantesAdminStaffRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const collectionPath = "/v1/restaurantes/:propertyId/admin/staff/invitaciones";
  const itemPath = "/v1/restaurantes/:propertyId/admin/staff/invitaciones/:inviteId";
  // Fase 12 — ver comentario de `serializeMember`/el describe de abajo: miembros YA
  // aceptados con `verticalRole === "repartidor"`, para el selector real de
  // `assign-repartidor`. Ruta separada de `collectionPath`/`itemPath` (invitaciones) a
  // propósito -- son dos recursos distintos (invitación pendiente vs. membership ya
  // aceptada) y `STAFF_INVITE_ROLES` (solo owner/admin) es deliberadamente MÁS angosto
  // que `MANAGER_ROLES` (owner/admin/staff, quien de verdad despacha pedidos día a
  // día) -- gatearla con `STAFF_INVITE_ROLES` le negaría el selector a un manager
  // "staff" que SÍ puede despachar vía admin-orders.ts.
  const repartidoresPath = "/v1/restaurantes/:propertyId/admin/staff/repartidores";

  app.use(collectionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(repartidoresPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(collectionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateInviteBody>(c.req.raw, 2 * 1024);
    if (typeof raw.email !== "string" || !EMAIL_RE.test(raw.email.trim())) throw Errors.validation("email inválido");
    if (typeof raw.verticalRole !== "string" || !isRestaurantesRole(raw.verticalRole)) {
      throw Errors.validation(`verticalRole inválido — se esperaba uno de: owner, admin, staff, repartidor.`);
    }
    const email = raw.email.trim().toLowerCase();
    const verticalRole = raw.verticalRole;
    const targetPlatformRole: PlatformRole = PLATFORM_ROLE_BY_VERTICAL_ROLE[verticalRole];

    // Segunda capa (además de `assertVerticalRole(STAFF_INVITE_ROLES)` de arriba):
    // jerarquía real de `core-authz`, genérica a las 6 verticales — un admin nunca da
    // de alta a otro owner, aunque "admin" sí esté en STAFF_INVITE_ROLES.
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
    // invita — mismo criterio de "nunca ensanchar el alcance" que ya aplica
    // `resolveEffectivePropertyIds` en el resto de rutas admin de este vertical.
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, null);

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

    // El envío por correo real queda fuera de fase (sin proveedor SMTP configurado
    // para este flujo) — mismo criterio "honesto" que
    // `rentasOwnerPortalInviteRoutes`: quien invita copia/pega este token en el
    // mensaje que le mande al invitado. Se devuelve UNA sola vez: solo el hash
    // persiste, nunca se puede recuperar de nuevo tras esta respuesta.
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

  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI: el panel de repartidor siempre estará vacío"). `MANAGER_ROLES`
  // (owner/admin/staff), no `STAFF_INVITE_ROLES` -- ver comentario de
  // `repartidoresPath` arriba. Usa `deps.coreStaffRepo(c.get("db"))` (fábrica
  // por-request, `auth.uid()` real de este mismo staff autenticado) + la función
  // `security definer` `core.list_org_members_by_vertical_role` (ver
  // `packages/db/migrations/0004_list_org_members_by_vertical_role.sql`) -- MISMO
  // mecanismo que usa ahora `admin-orders.ts::assign-repartidor` para su propia
  // validación (antes rota en producción real, ver el comentario de esa migración).
  app.get(repartidoresPath, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const members = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(organizationId, "repartidor");
    return c.json({ repartidores: members.map(serializeMember) });
  });

  return app;
}
