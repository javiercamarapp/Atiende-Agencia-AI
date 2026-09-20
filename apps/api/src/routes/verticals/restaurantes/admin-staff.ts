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
import { correoInvitacionStaff, isRestaurantesRole, MANAGER_ROLES, PLATFORM_ROLE_BY_VERTICAL_ROLE, STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import { MembershipRemovalError, MembershipRemovalUnavailableError, MembershipRoleUpdateError } from "@atiende/db";
import type { OrganizationMemberRow, OrganizationMemberWithRoleRow, StaffInviteRow } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

// 7 días — misma vigencia que el portal de propietario de rentas
// (`rentasOwnerPortalInviteRoutes::INVITE_TTL_MS`), razonable para que quien invita
// comparta el link sin presión y sin dejarlo abierto indefinidamente.
const STAFF_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Enmascara el correo del invitado antes de guardarlo en la bitácora de
 *  auditoría (`restaurantes.audit_log`, append-only e imborrable -- hallazgo
 *  no bloqueante del revisor independiente del PR #183: el correo COMPLETO ahí
 *  impide atender después una solicitud de borrado/ARCO sobre ese invitado, y
 *  el correo ya es visible de todas formas en `GET .../staff/invitaciones`
 *  mientras la invitación siga pendiente). Conserva el primer carácter + el
 *  dominio completo -- suficiente para reconocer a quién se invitó en el
 *  resumen, nunca el correo completo -- mismo criterio que
 *  `apps/api/src/superadmin-acciones/resumen.ts::enmascararDestinatario`. */
function enmascararCorreoInvitado(email: string): string {
  const arroba = email.indexOf("@");
  if (arroba <= 0) return "***";
  return `${email[0]}***@${email.slice(arroba + 1)}`;
}

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

/**
 * Correo real vía `restaurantes.messaging_outbox` con el enlace de activación
 * ya armado — best-effort: un fallo al encolar el correo NUNCA debe revertir
 * la invitación que sí quedó creada (`createStaffInvite`, ya persistida por
 * el caller ANTES de invocar esto, misma sesión de staff).
 *
 * SAVEPOINT (corrección de revisión sobre PR #176, mismo patrón que
 * `order-notifications.ts::tryNotifyStaffNewOrder`): esta ruta corre en la
 * sesión de STAFF del request, en la MISMA transacción que ya persistió
 * `createStaffInvite`. Sin `runWithRowSavepoint`, un error real de Postgres
 * en el encolado (deadlock/timeout transitorio, o `42501` del guard) deja la
 * transacción en 25P02 y el `commit;` que sigue
 * (`managed-postgres-engine.ts`) revierte también la invitación con
 * `AbortedTransactionCommitError` -> 500, justo lo que este best-effort
 * promete que nunca pasa. Exportada para poder probarla directamente con
 * `PostgresRestaurantesRepository` + `AbortAwareFakeSession` sin pasar por la
 * ruta HTTP completa (ver `restaurantes-admin-staff-savepoint.spec.ts`).
 */
export async function tryEnqueueStaffInviteEmail(
  repo: RestaurantesRepository,
  organizationId: string,
  inviteId: string,
  email: string,
  correo: { readonly asunto: string; readonly html: string; readonly texto: string },
): Promise<void> {
  try {
    await repo.runWithRowSavepoint(() =>
      repo.enqueueMessagingOutbox(organizationId, "email", "staff.invite", `staff-invite:${inviteId}`, {
        to: email,
        subject: correo.asunto,
        html: correo.html,
        text: correo.texto,
      }),
    );
  } catch (err) {
    console.error("admin-staff: best-effort staff invite email enqueue failed:", err);
  }
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

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): a diferencia de
// `serializeMember` de arriba (Fase 12, deliberadamente sin rol — ese selector ya
// conoce el rol, lo pidió como filtro), este SÍ incluye `verticalRole` — es
// justo el dato que la tabla nueva "Staff activo" necesita mostrar/editar.
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
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): dos rutas nuevas,
  // separadas de `collectionPath`/`itemPath` (invitaciones PENDIENTES) por el mismo
  // motivo que `repartidoresPath` (recurso distinto: membership YA ACEPTADA) —
  // `miembrosPath` lista TODOS los miembros con su rol actual, `miembroItemPath`
  // cambia el rol de uno. Gateadas con `STAFF_INVITE_ROLES` (mismo umbral que
  // invitar — cambiar el rol de alguien es, al menos, igual de sensible que darlo de
  // alta).
  const miembrosPath = "/v1/restaurantes/:propertyId/admin/staff/miembros";
  const miembroItemPath = "/v1/restaurantes/:propertyId/admin/staff/miembros/:userId";

  app.use(collectionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(itemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(repartidoresPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(miembrosPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(miembroItemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

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
    const staffRepo = deps.coreStaffRepo(c.get("db"));
    const existingStaff = await staffRepo.findStaffForOrgAdmin(organizationId, email);
    if (existingStaff) {
      const alreadyMember = await staffRepo.isStaffOrgMember(organizationId, existingStaff.id);
      if (alreadyMember) {
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

    // Hallazgo de auditoría cerrado en esta misma pasada: hasta ahora el envío por
    // correo real quedaba fuera de fase (mismo criterio "honesto" que
    // `rentasOwnerPortalInviteRoutes`, que TODAVÍA no lo cierra) — quien invita
    // tenía que copiar/pegar este token a mano. Ahora se encola además el correo
    // real vía `restaurantes.messaging_outbox` (channel='email',
    // @atiende/domain-restaurantes::email-dispatch.ts drena el envío real, ver
    // email-dispatch.ts de este mismo directorio) con el enlace de activación ya
    // armado — best-effort: un fallo al encolar el correo NUNCA debe revertir la
    // invitación que sí quedó creada. El token se sigue devolviendo UNA sola vez
    // en la respuesta HTTP (solo el hash persiste, nunca se puede recuperar de
    // nuevo) por si quien invita prefiere compartirlo por otro medio.
    const acceptUrl = `${deps.env.appBaseUrl}/aceptar-invitacion?token=${encodeURIComponent(tokenPlain)}`;
    const correo = correoInvitacionStaff({
      email,
      verticalRole,
      acceptUrl,
      expiresAtTexto: new Intl.DateTimeFormat("es-MX", { dateStyle: "long" }).format(new Date(expiresAt)),
    });
    await tryEnqueueStaffInviteEmail(deps.restaurantesRepo(c.get("db")), organizationId, invite.id, email, correo);

    // Hallazgo de auditoría (observabilidad) — trazabilidad de acciones
    // administrativas de staff: quién (actorUserId), qué (evento), sobre qué
    // (email/verticalRole invitados) y cuándo (campo `ts` de `logEvent`), con el
    // `requestId` del propio request para correlacionar contra el resto de logs
    // de esta misma llamada HTTP (ver `../../../logger.ts`).
    logEvent(c, "info", "restaurantes_admin_staff_invitado", {
      actorUserId: staffId,
      organizationId,
      propertyIds,
      inviteId: invite.id,
      invitedEmail: email,
      verticalRole,
    });

    // FASE 3 (producto) — "invitación ... de staff" (ver
    // packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql).
    // Correo ENMASCARADO (corrección de revisión sobre el PR #183, ver
    // `enmascararCorreoInvitado` arriba) -- sigue siendo el dato mínimo
    // indispensable para reconocer a quién se invitó (mandato de la fase: "sin
    // PII innecesaria", no "sin ningún dato identificador"), pero nunca el
    // correo completo en una tabla append-only que nadie puede borrar. Best-
    // effort real, nunca revierte la invitación ya creada.
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "staff.invitado",
      entityType: "staff",
      entityId: invite.id,
      campo: "email,verticalRole",
      antes: null,
      despues: `${enmascararCorreoInvitado(email)} (${verticalRole})`,
    });

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
    logEvent(c, "info", "restaurantes_admin_staff_invitacion_revocada", { actorUserId: c.get("userId"), organizationId, inviteId });

    // FASE 3 (producto) — "baja ... de staff": revocar una invitación PENDIENTE
    // es la única forma real de "baja" que existe hoy en restaurantes (no hay
    // ruta para dar de baja a un miembro YA ACEPTADO -- ver knownGaps del PR).
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "staff.invitacion_revocada",
      entityType: "staff",
      entityId: inviteId,
      campo: null,
      antes: null,
      despues: null,
    });

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

  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto"): verificado contra el
  // código real que ni siquiera restaurantes podía hacer esto -- `POST
  // collectionPath` de arriba solo fija el rol AL INVITAR, ningún endpoint cambiaba
  // el rol de un staff YA ACEPTADO. Lista TODOS los miembros (no solo
  // "repartidor") con su `verticalRole` actual, para la tabla nueva "Staff activo"
  // del panel.
  app.get(miembrosPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const members = await deps.coreStaffRepo(c.get("db")).listOrgMembers(organizationId);
    return c.json({ miembros: members.map(serializeMemberWithRole) });
  });

  // Cambia el `verticalRole` (y su `platformRole` mapeado) de un staff YA ACEPTADO.
  // Autorización en DOS capas, mismo criterio exacto que `POST collectionPath`
  // (invitar) de arriba:
  //   1. `assertVerticalRole(STAFF_INVITE_ROLES)` -- primer filtro (quién llega
  //      siquiera a la ruta).
  //   2. `canInviteStaff` aplicado DOS veces (al rol ACTUAL del target y al rol
  //      NUEVO que se le quiere asignar) -- la MISMA jerarquía que ya aplica al
  //      invitar, reutilizada tal cual (nunca se reimplementa): un admin nunca toca
  //      a un owner, ni puede ascender a nadie por encima de su propio rango.
  // La AUTORIDAD real, sin embargo, es `core.update_membership_role` (`security
  // definer`, ver `packages/db/migrations/0007_update_membership_role.sql`) --
  // reaplica esta MISMA regla dentro de la función SQL (más el bloqueo de
  // auto-cambio de rol) y es quien de verdad escribe `core.membership`; estas dos
  // capas de TS son solo el primer filtro/mejor mensaje de error, nunca la única
  // barrera (mismo principio "RLS real, TS es defensa en profundidad" del resto del
  // monorepo).
  app.patch(miembroItemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const callerUserId = c.get("userId");
    const targetUserId = c.req.param("userId");

    if (targetUserId === callerUserId) throw Errors.validation("No puedes cambiar tu propio rol.");

    const raw = await readJsonCapped<UpdateMemberRoleBody>(c.req.raw, 1 * 1024);
    if (typeof raw.verticalRole !== "string" || !isRestaurantesRole(raw.verticalRole)) {
      throw Errors.validation(`verticalRole inválido — se esperaba uno de: owner, admin, staff, repartidor.`);
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

      // FASE 3 (producto) — "cambio de rol de staff". Nunca guarda el correo del
      // target aquí (ya visible en `target.email` del listado, no hace falta
      // duplicarlo en la bitácora) -- solo el id de usuario + el rol antes/
      // después, el resumen mínimo que la fase pide.
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: callerUserId,
        action: "staff.rol_actualizado",
        entityType: "staff",
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

  // FASE 3 (producto) — hallazgo real: hasta ahora NO existía ninguna forma de dar
  // de baja a un miembro de staff YA ACEPTADO (`core.membership`) -- solo revocar
  // una invitación PENDIENTE (`DELETE itemPath` de arriba). Mismo umbral de
  // autorización EXACTO que `PATCH miembroItemPath` (STAFF_INVITE_ROLES + jerarquía
  // real de `canInviteStaff`, aplicada al rol ACTUAL del target) -- decisión
  // explícita de esta fase para el caso límite:
  //   1. Nunca auto-baja (un staff no puede darse de baja a sí mismo por esta vía)
  //      -- bloqueado ANTES de tocar la base, mismo criterio que "nunca auto-cambio
  //      de rol" del PATCH de arriba.
  //   2. "No dejar la organización sin ningún owner" -- si el target es el ÚNICO
  //      owner, la baja se rechaza (aunque quien la pida sea OTRO owner de igual
  //      rango, la única combinación que la jerarquía permitiría).
  // La AUTORIDAD real, sin embargo, es `core.remove_membership` (`security
  // definer`, ver `packages/db/migrations/0022_remove_membership.sql`) -- estas
  // dos capas de TS son solo el primer filtro/mejor mensaje de error, nunca la
  // única barrera (mismo principio "RLS real, TS es defensa en profundidad" del
  // resto del monorepo). `MembershipRemovalUnavailableError` (SQLSTATE 42883, la
  // migración 0022 todavía no se aplicó a la base real) se traduce a un 503
  // honesto -- REGLA DURA de compatibilidad de AGENTS.md: esta es una capacidad
  // NUEVA sin camino anterior al que degradar, nunca un 500 genérico.
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
    if (!callerPlatformRole || !canInviteStaff(callerPlatformRole, target.platformRole)) {
      throw Errors.staffRemovalRolInsuficiente();
    }

    // Caso límite decidido explícitamente para esta fase (ver comentario de
    // cabecera): nunca dejar la organización sin ningún owner.
    if (target.verticalRole === "owner" && members.filter((m) => m.platformRole === "owner").length <= 1) {
      throw Errors.staffRemovalSinOwner();
    }

    try {
      await deps.coreStaffRepo(c.get("db")).removeMembership(organizationId, targetUserId);
    } catch (err) {
      if (err instanceof MembershipRemovalError) throw Errors.forbidden(err.message);
      if (err instanceof MembershipRemovalUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    logEvent(c, "info", "restaurantes_admin_staff_dado_de_baja", { actorUserId: callerUserId, organizationId, targetUserId });

    // FASE 3 (producto) — "baja ... de staff" (ver migrations/
    // 019_restaurantes_audit_log.sql). Nunca guarda el correo del target (ya
    // visible en el listado mientras existió, no hace falta duplicarlo en una
    // bitácora append-only) -- solo el id de usuario + el rol que tenía.
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: callerUserId,
      action: "staff.baja",
      entityType: "staff",
      entityId: targetUserId,
      campo: "verticalRole",
      antes: target.verticalRole,
      despues: null,
    });

    return c.json({ ok: true });
  });

  return app;
}
