// InMemoryCoreRepository — implementación real (no un mock) de `CoreRepository` +
// `CoreStaffRepository` respaldada por Maps, con las mismas restricciones de
// integridad que el DDL de `migrations/0001_core_schema.sql`/
// `migrations/0002_staff_invite_schema.sql` (email único, membership por (userId,
// orgId), token de invitación único). Sirve para tests determinísticos de las rutas
// de login/invitación y como fallback dev/CI sin Postgres real — mismo rol que
// `InMemoryStateStore` en `@atiende/core-conversation`.
//
// Implementa AMBAS interfaces (ver comentario de cabecera en `core-repository.ts`
// para por qué existen separadas) porque en memoria no hay ninguna diferencia real
// de sesión/RLS que preservar — los tests que ejercitan invitaciones vía
// `AppDeps.coreStaffRepo` y los que ejercitan login vía `AppDeps.coreRepo` comparten
// la MISMA instancia (`coreStaffRepo: (_db) => coreRepo`, ver
// `apps/api/tests/fixtures.ts`), así que el estado siempre queda consistente entre
// ambos.
import { randomUUID } from "node:crypto";
import type {
  AcceptStaffInviteInput,
  AcceptStaffInviteResult,
  BillingWebhookEventMark,
  CoreRepository,
  CoreStaffRepository,
  CreateProspectoInput,
  CreateStaffInviteInput,
  MembershipRow,
  NotificationRow,
  OrganizationBillingRow,
  OrganizationMemberRow,
  OrganizationMemberWithRoleRow,
  ProspectoRow,
  RevokeRefreshTokenInput,
  StaffInviteRow,
  StaffUserRow,
  SuperadminOrganizationRow,
  UpsertOrganizationBillingInput,
} from "./core-repository.ts";
import {
  MembershipRoleUpdateError,
  NotificationNotFoundError,
  OrganizationBillingAccessDeniedError,
  OrganizationNotFoundError,
  ProspectoNotFoundError,
  StaffInviteInvalidError,
} from "./core-repository.ts";

export interface SeedOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly vertical: string;
  /** Opcional (default 'active'/ahora) — decenas de fixtures existentes
   *  construyen `SeedOrganization` sin estos dos campos; solo
   *  `listAllOrganizationsForSuperadmin` los necesita de verdad. */
  readonly status?: "trial" | "active" | "suspended";
  readonly createdAt?: string;
}

export interface SeedMembership {
  readonly userId: string;
  readonly organizationId: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

export class InMemoryCoreRepository implements CoreRepository, CoreStaffRepository {
  private readonly staffById = new Map<string, StaffUserRow>();
  private readonly staffIdByEmail = new Map<string, string>();
  private readonly organizations = new Map<string, SeedOrganization>();
  private readonly memberships: SeedMembership[] = [];
  private readonly invitesById = new Map<string, StaffInviteRow>();
  private readonly inviteIdByTokenHash = new Map<string, string>();
  // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles") — jti -> revocado. Solo el `jti` se guarda, nunca el JWT completo
  // (mismo criterio que un password/token de invitación); ver `revokeRefreshToken`.
  private readonly revokedRefreshTokenJtis = new Set<string>();
  // Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
  // sesiones activas de un usuario") — userId -> ISO 8601 del corte de
  // `revokeAllRefreshTokens`. Mapa aparte en vez de mutar el `StaffUserRow` guardado
  // en `staffById` para que `addStaff` (usado por decenas de fixtures existentes) no
  // tenga que empezar a conocer este campo — `findStaffByEmail`/`findStaffById` lo
  // mezclan al leer, mismo criterio que Postgres lo trae como columna de la misma
  // fila real (ver `postgres-core-repository.ts`).
  private readonly sessionsRevokedAtByUserId = new Map<string, string>();
  // "Sign in with Google" (ver `apps/api/src/routes/auth-google.ts`) — `sub` (subject
  // id del id_token de Google) -> staffId vinculado, mismo dato que
  // `core.staff_google_identity` en Postgres. Mapa aparte por el mismo motivo que
  // `sessionsRevokedAtByUserId` arriba: no forzar a cada fixture existente que
  // construye un `StaffUserRow` a conocer un campo que no le corresponde.
  private readonly staffIdByGoogleSub = new Map<string, string>();
  // "Continuar con correo" sin contraseña — tokenHash -> {staffId, expiresAt,
  // used}, mismo dato que `core.magic_link_token` en Postgres.
  private readonly magicLinkTokens = new Map<string, { staffId: string; expiresAt: string; used: boolean }>();
  // Código de intercambio de un solo uso (hallazgo P2, tokens en URL) — codeHash ->
  // {staffId, expiresAt, used}, mismo dato que `core.auth_exchange_code` en Postgres.
  private readonly authExchangeCodes = new Map<string, { staffId: string; expiresAt: string; used: boolean }>();
  // Back office de plataforma — mismo dato que `core.platform_superadmin`.
  private readonly platformSuperadmins = new Set<string>();
  // Infraestructura de notificaciones — mismo dato que `core.notification`, con
  // `staffUserId` guardado aparte (no expuesto en `NotificationRow`, mismo criterio
  // que `SeedMembership.userId` para membership) para poder filtrar por dueño.
  private readonly notifications = new Map<string, NotificationRow & { readonly staffUserId: string }>();
  // "notificationId" leída por CADA staff que la marcó — mismo dato que
  // `core.notification_read` (clave compuesta staff+notificación), aquí como
  // `Set<`${staffUserId}:${notificationId}`>` porque `NotificationRow.readAt` ya vive
  // mezclado por-lectura en `withReadAt` de abajo, nunca mutado en la fila guardada.
  private readonly notificationReadsByStaff = new Map<string, Set<string>>();
  // `readKey (\`${staffUserId}:${notificationId}\`) -> readAt` guardado aparte de
  // `notificationReadsByStaff` (que solo necesita saber SI se leyó, para `Set.has`)
  // porque el propio `NotificationRow` necesita el timestamp real -- misma
  // separación de mapas que `sessionsRevokedAtByUserId` arriba (nunca mutar la fila
  // guardada en `this.notifications`, mezclar solo al leer).
  private readonly readAtByKey = new Map<string, string>();
  // "Cerebro de ventas" — mismo dato que `core.prospecto`.
  private readonly prospectos = new Map<string, ProspectoRow>();
  // Suscripción SaaS propia de Atiende — mismo dato que `core.organization_billing`
  // (una fila por organización, ausente = nunca inició un checkout).
  private readonly organizationBilling = new Map<
    string,
    Omit<OrganizationBillingRow, "organizationId" | "vertical" | "ownerEmail">
  >();
  // Ledger anti-duplicado — mismo dato que `core.billing_webhook_event`.
  private readonly seenBillingWebhookEventIds = new Set<string>();
  // Ledger anti-reordenamiento — mismo dato que `core.billing_entity_order`.
  private readonly billingEntityOrder = new Map<string, number>();

  /** Solo para fixtures de prueba (`apps/api/tests/fixtures.ts`) — agrega una
   *  notificación ya creada (mismo criterio que `addStaff`/`addMembership`: nunca
   *  invocado desde código de producción, ahí el alta real vive donde sea que un
   *  dominio decida escribir `core.notification`). `readAt` se ignora aquí a
   *  propósito (siempre nace no leída, igual que una fila real recién insertada) —
   *  usa `markNotificationRead`/`markAllNotificationsRead` para simular que ya se
   *  leyó. */
  addNotification(staffUserId: string, notification: Omit<NotificationRow, "readAt">): void {
    this.notifications.set(notification.id, { ...notification, readAt: null, staffUserId });
  }

  /** Solo para fixtures de prueba (`apps/api/tests/fixtures.ts`) — mismo
   *  criterio que `addStaff`/`addMembership`, nunca invocado desde código de
   *  producción (ahí el alta real vive en la migración SQL). */
  addPlatformSuperadmin(staffId: string): void {
    this.platformSuperadmins.add(staffId);
  }

  addStaff(staff: StaffUserRow): void {
    if (this.staffIdByEmail.has(staff.email)) {
      throw new Error(`ya existe un staff_user con email "${staff.email}"`);
    }
    this.staffById.set(staff.id, staff);
    this.staffIdByEmail.set(staff.email, staff.id);
  }

  addOrganization(org: SeedOrganization): void {
    this.organizations.set(org.id, org);
  }

  addMembership(membership: SeedMembership): void {
    if (this.memberships.some((m) => m.userId === membership.userId && m.organizationId === membership.organizationId)) {
      throw new Error(`ya existe membership (${membership.userId}, ${membership.organizationId})`);
    }
    this.memberships.push(membership);
  }

  /** Adjunta `sessionsRevokedAt` (mapa aparte, ver comentario de cabecera) a la fila
   *  guardada de `staffById` — nunca muta el `StaffUserRow` original. */
  private withSessionsRevokedAt(staff: StaffUserRow): StaffUserRow {
    return { ...staff, sessionsRevokedAt: this.sessionsRevokedAtByUserId.get(staff.id) ?? null };
  }

  async findStaffByEmail(email: string): Promise<StaffUserRow | null> {
    const id = this.staffIdByEmail.get(email);
    if (!id) return null;
    const staff = this.staffById.get(id);
    return staff ? this.withSessionsRevokedAt(staff) : null;
  }

  async findStaffById(id: string): Promise<StaffUserRow | null> {
    const staff = this.staffById.get(id);
    return staff ? this.withSessionsRevokedAt(staff) : null;
  }

  async findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]> {
    return this.memberships
      .filter((m) => m.userId === userId)
      .map((m) => {
        const org = this.organizations.get(m.organizationId);
        if (!org) throw new Error(`membership apunta a organización inexistente "${m.organizationId}"`);
        return {
          organizationId: org.id,
          organizationSlug: org.slug,
          organizationName: org.name,
          vertical: org.vertical,
          platformRole: m.platformRole,
          verticalRole: m.verticalRole,
          propertyIds: m.propertyIds,
        };
      });
  }

  // ---- CoreStaffRepository (sesión real por-request en producción; aquí, misma
  // instancia compartida — ver comentario de cabecera del archivo) ----

  async createStaffInvite(input: CreateStaffInviteInput): Promise<StaffInviteRow> {
    if (this.inviteIdByTokenHash.has(input.tokenHash)) {
      throw new Error("ya existe una invitación con ese tokenHash (colisión de token, no debería pasar nunca)");
    }
    const row: StaffInviteRow = {
      id: randomUUID(),
      email: input.email,
      organizationId: input.organizationId,
      platformRole: input.platformRole,
      verticalRole: input.verticalRole,
      propertyIds: input.propertyIds,
      status: "pending",
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      acceptedBy: null,
      createdAt: new Date().toISOString(),
    };
    this.invitesById.set(row.id, row);
    this.inviteIdByTokenHash.set(input.tokenHash, row.id);
    return row;
  }

  async listPendingStaffInvites(organizationId: string): Promise<readonly StaffInviteRow[]> {
    return [...this.invitesById.values()]
      .filter((i) => i.organizationId === organizationId && i.status === "pending")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeStaffInvite(id: string, organizationId: string): Promise<boolean> {
    const invite = this.invitesById.get(id);
    if (!invite || invite.organizationId !== organizationId || invite.status !== "pending") return false;
    this.invitesById.set(id, { ...invite, status: "revoked" });
    return true;
  }

  // Fase 12 — ver el contrato completo (y el gap de RLS real que este método existe
  // para corregir) en `core-repository.ts`/`postgres-core-repository.ts`. En memoria
  // no hay ninguna sesión/RLS que emular (mismo criterio que el resto de este
  // archivo): solo filtra `this.memberships` por organización + vertical_role exacto.
  async listMembersByVerticalRole(organizationId: string, verticalRole: string): Promise<readonly OrganizationMemberRow[]> {
    return this.memberships
      .filter((m) => m.organizationId === organizationId && m.verticalRole === verticalRole)
      .map((m) => {
        const staff = this.staffById.get(m.userId);
        if (!staff) throw new Error(`membership apunta a staff_user inexistente "${m.userId}"`);
        return { userId: staff.id, email: staff.email, fullName: staff.fullName, propertyIds: m.propertyIds };
      });
  }

  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto") — igual criterio que
  // `listMembersByVerticalRole` de arriba: en memoria no hay ninguna sesión/RLS que
  // emular (mismo criterio que el resto de este archivo), solo filtra
  // `this.memberships` por organización, sin el filtro de `vertical_role`.
  async listOrgMembers(organizationId: string): Promise<readonly OrganizationMemberWithRoleRow[]> {
    return this.memberships
      .filter((m) => m.organizationId === organizationId)
      .map((m) => {
        const staff = this.staffById.get(m.userId);
        if (!staff) throw new Error(`membership apunta a staff_user inexistente "${m.userId}"`);
        return { userId: staff.id, email: staff.email, fullName: staff.fullName, platformRole: m.platformRole, verticalRole: m.verticalRole, propertyIds: m.propertyIds };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA) — a diferencia
  // de `listOrgMembers`/`listMembersByVerticalRole` (solo lectura, sin emular RLS a
  // propósito), esta es una ESCRITURA de privilegio: en producción real, la
  // autoridad completa (rango de `canInviteStaff` aplicado tanto al rol ACTUAL como
  // al rol NUEVO del target, más el bloqueo de auto-cambio de rol) vive en
  // `core.update_membership_role` (`security definer`, ver
  // `migrations/0007_update_membership_role.sql`) -- el caller HTTP (`admin-
  // staff.ts`) ya reaplica esa MISMA jerarquía en la capa TS ANTES de llamar aquí
  // (defensa en profundidad, mismo patrón exacto que `canInviteStaff` ya aplica al
  // invitar), así que esta implementación en memoria solo necesita el caso real que
  // le falta a esa capa TS: el target simplemente no existe en la organización (ni
  // el chequeo de rango ni el de auto-cambio dependen de qué adaptador corre por
  // debajo).
  async updateMemberVerticalRole(
    organizationId: string,
    targetUserId: string,
    newPlatformRole: "owner" | "admin" | "member" | "viewer",
    newVerticalRole: string,
  ): Promise<OrganizationMemberWithRoleRow> {
    const idx = this.memberships.findIndex((m) => m.organizationId === organizationId && m.userId === targetUserId);
    if (idx < 0) throw new MembershipRoleUpdateError("el staff indicado no pertenece a esta organización.");
    const current = this.memberships[idx]!;
    const updated: SeedMembership = { ...current, platformRole: newPlatformRole, verticalRole: newVerticalRole };
    this.memberships[idx] = updated;
    const staff = this.staffById.get(targetUserId);
    if (!staff) throw new Error(`membership apunta a staff_user inexistente "${targetUserId}"`);
    return { userId: staff.id, email: staff.email, fullName: staff.fullName, platformRole: updated.platformRole, verticalRole: updated.verticalRole, propertyIds: updated.propertyIds };
  }

  // ---- CoreRepository (sesión de sistema, igual que login) ----

  async findStaffInviteByTokenHash(tokenHash: string): Promise<StaffInviteRow | null> {
    const id = this.inviteIdByTokenHash.get(tokenHash);
    return id ? (this.invitesById.get(id) ?? null) : null;
  }

  async acceptStaffInvite(input: AcceptStaffInviteInput): Promise<AcceptStaffInviteResult> {
    const invite = await this.findStaffInviteByTokenHash(input.tokenHash);
    if (!invite || invite.status !== "pending" || new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new StaffInviteInvalidError();
    }

    let staff = await this.findStaffByEmail(invite.email);
    if (!staff) {
      staff = {
        id: randomUUID(),
        email: invite.email,
        fullName: input.fullName,
        passwordHash: input.passwordHash,
        createdVia: "invite",
        emailVerifiedAt: new Date().toISOString(),
      };
      this.staffById.set(staff.id, staff);
      this.staffIdByEmail.set(staff.email, staff.id);
    }

    const existingIdx = this.memberships.findIndex((m) => m.userId === staff!.id && m.organizationId === invite.organizationId);
    const membership: SeedMembership = {
      userId: staff.id,
      organizationId: invite.organizationId,
      platformRole: invite.platformRole,
      verticalRole: invite.verticalRole,
      propertyIds: invite.propertyIds,
    };
    if (existingIdx >= 0) this.memberships[existingIdx] = membership;
    else this.memberships.push(membership);

    this.invitesById.set(invite.id, { ...invite, status: "accepted", acceptedAt: new Date().toISOString(), acceptedBy: staff.id });

    const org = this.organizations.get(invite.organizationId);
    if (!org) throw new Error(`invitación apunta a organización inexistente "${invite.organizationId}"`);

    return {
      staffId: staff.id,
      email: staff.email,
      organizationId: invite.organizationId,
      vertical: org.vertical,
      platformRole: invite.platformRole,
      verticalRole: invite.verticalRole,
      propertyIds: invite.propertyIds,
    };
  }

  // ---- Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles") — ver el comentario de `revokeRefreshToken`/`isRefreshTokenRevoked` en
  // `core-repository.ts` para el contrato completo. `userId`/`expiresAt` no se
  // guardan aquí (el Set solo necesita el `jti` para responder `isRefreshTokenRevoked`)
  // — la versión Postgres sí los persiste, para auditoría y para un futuro job de
  // limpieza por expiración natural. ----

  async revokeRefreshToken(input: RevokeRefreshTokenInput): Promise<void> {
    this.revokedRefreshTokenJtis.add(input.jti);
  }

  async isRefreshTokenRevoked(jti: string): Promise<boolean> {
    return this.revokedRefreshTokenJtis.has(jti);
  }

  // ---- Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
  // sesiones activas de un usuario") — ver el comentario de `sessionsRevokedAtByUserId`
  // arriba y el contrato completo en `core-repository.ts::revokeAllRefreshTokens`. ----

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    this.sessionsRevokedAtByUserId.set(userId, new Date().toISOString());
  }

  // ---- "Sign in with Google" — ver el contrato completo en
  // `core-repository.ts::findStaffByGoogleSub`/`linkGoogleIdentity`. ----

  async findStaffByGoogleSub(sub: string): Promise<StaffUserRow | null> {
    const staffId = this.staffIdByGoogleSub.get(sub);
    if (!staffId) return null;
    const staff = this.staffById.get(staffId);
    return staff ? this.withSessionsRevokedAt(staff) : null;
  }

  async linkGoogleIdentity(input: { readonly staffId: string; readonly sub: string; readonly email: string }): Promise<void> {
    const existingStaffId = this.staffIdByGoogleSub.get(input.sub);
    if (existingStaffId && existingStaffId !== input.staffId) return; // mismo criterio no-op que el `on conflict ... where` de Postgres.
    this.staffIdByGoogleSub.set(input.sub, input.staffId);
  }

  // ---- "Continuar con correo" sin contraseña — ver el contrato completo en
  // `core-repository.ts::createMagicLinkToken`/`consumeMagicLinkToken`. ----

  async createMagicLinkToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    this.magicLinkTokens.set(input.tokenHash, { staffId: input.staffId, expiresAt: input.expiresAt, used: false });
  }

  async consumeMagicLinkToken(tokenHash: string): Promise<StaffUserRow | null> {
    const entry = this.magicLinkTokens.get(tokenHash);
    if (!entry || entry.used || new Date(entry.expiresAt).getTime() <= Date.now()) return null;
    entry.used = true;
    const staff = this.staffById.get(entry.staffId);
    return staff ? this.withSessionsRevokedAt(staff) : null;
  }

  // ---- Código de intercambio de un solo uso (hallazgo P2, tokens en URL) — ver
  // el contrato completo en `core-repository.ts::createAuthExchangeCode`/
  // `consumeAuthExchangeCode`. ----

  async createAuthExchangeCode(input: { readonly staffId: string; readonly codeHash: string; readonly expiresAt: string }): Promise<void> {
    this.authExchangeCodes.set(input.codeHash, { staffId: input.staffId, expiresAt: input.expiresAt, used: false });
  }

  async consumeAuthExchangeCode(codeHash: string): Promise<StaffUserRow | null> {
    const entry = this.authExchangeCodes.get(codeHash);
    if (!entry || entry.used || new Date(entry.expiresAt).getTime() <= Date.now()) return null;
    entry.used = true;
    const staff = this.staffById.get(entry.staffId);
    return staff ? this.withSessionsRevokedAt(staff) : null;
  }

  // ---- Back office de plataforma — ver el contrato completo en
  // `core-repository.ts::isPlatformSuperadmin`/`listAllOrganizationsForSuperadmin`/
  // `countStaffByOrganizationForSuperadmin`. ----

  async isPlatformSuperadmin(staffId: string): Promise<boolean> {
    return this.platformSuperadmins.has(staffId);
  }

  async listAllOrganizationsForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationRow[]> {
    if (!this.platformSuperadmins.has(callerId)) return [];
    return [...this.organizations.values()].map((org) => ({
      id: org.id,
      vertical: org.vertical,
      name: org.name,
      slug: org.slug,
      status: org.status ?? "active",
      createdAt: org.createdAt ?? new Date(0).toISOString(),
    }));
  }

  async countStaffByOrganizationForSuperadmin(callerId: string): Promise<ReadonlyMap<string, number>> {
    if (!this.platformSuperadmins.has(callerId)) return new Map();
    const counts = new Map<string, number>();
    for (const m of this.memberships) {
      counts.set(m.organizationId, (counts.get(m.organizationId) ?? 0) + 1);
    }
    return counts;
  }

  // ---- Infraestructura de notificaciones — ver el contrato completo en
  // `core-repository.ts`. En memoria no hay ninguna sesión/RLS que emular (mismo
  // criterio que el resto de este archivo): solo filtra `this.notifications` por
  // `staffUserId` y resuelve `readAt` contra `notificationReadsByStaff`. ----

  private withReadAt(n: NotificationRow & { readonly staffUserId: string }, staffId: string): NotificationRow {
    const readKey = `${staffId}:${n.id}`;
    const read = this.notificationReadsByStaff.get(staffId)?.has(n.id) ?? false;
    return { id: n.id, vertical: n.vertical, titulo: n.titulo, cuerpo: n.cuerpo, entidadTipo: n.entidadTipo, entidadId: n.entidadId, createdAt: n.createdAt, readAt: read ? (this.readAtByKey.get(readKey) ?? new Date().toISOString()) : null };
  }

  async listNotificationsForStaff(staffId: string): Promise<readonly NotificationRow[]> {
    return [...this.notifications.values()]
      .filter((n) => n.staffUserId === staffId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((n) => this.withReadAt(n, staffId));
  }

  async countUnreadNotificationsForStaff(staffId: string): Promise<number> {
    const read = this.notificationReadsByStaff.get(staffId);
    return [...this.notifications.values()].filter((n) => n.staffUserId === staffId && !(read?.has(n.id) ?? false)).length;
  }

  async markNotificationRead(staffId: string, notificationId: string): Promise<void> {
    const notification = this.notifications.get(notificationId);
    if (!notification || notification.staffUserId !== staffId) throw new NotificationNotFoundError();
    let read = this.notificationReadsByStaff.get(staffId);
    if (!read) {
      read = new Set<string>();
      this.notificationReadsByStaff.set(staffId, read);
    }
    if (!read.has(notificationId)) {
      read.add(notificationId);
      this.readAtByKey.set(`${staffId}:${notificationId}`, new Date().toISOString());
    }
  }

  async markAllNotificationsRead(staffId: string): Promise<number> {
    let read = this.notificationReadsByStaff.get(staffId);
    if (!read) {
      read = new Set<string>();
      this.notificationReadsByStaff.set(staffId, read);
    }
    let affected = 0;
    const now = new Date().toISOString();
    for (const n of this.notifications.values()) {
      if (n.staffUserId !== staffId || read.has(n.id)) continue;
      read.add(n.id);
      this.readAtByKey.set(`${staffId}:${n.id}`, now);
      affected += 1;
    }
    return affected;
  }

  // ---- "Cerebro de ventas" — ver el contrato completo en `core-repository.ts`. En
  // memoria, el chequeo de autorización espeja el `where core.is_platform_superadmin
  // (p_caller_id)` real: `list` devuelve vacío, `create`/`update` lanzan. ----

  async listProspectosForSuperadmin(callerId: string): Promise<readonly ProspectoRow[]> {
    if (!this.platformSuperadmins.has(callerId)) return [];
    return [...this.prospectos.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createProspectoForSuperadmin(callerId: string, input: CreateProspectoInput): Promise<ProspectoRow> {
    if (!this.platformSuperadmins.has(callerId)) throw new Error("forbidden");
    const now = new Date().toISOString();
    const row: ProspectoRow = {
      id: randomUUID(),
      empresa: input.empresa,
      vertical: input.vertical,
      ciudad: input.ciudad,
      contactoNombre: input.contactoNombre,
      telefono: input.telefono,
      correo: input.correo,
      estado: "nuevo",
      fuente: input.fuente,
      notas: input.notas,
      creadoPor: callerId,
      createdAt: now,
      updatedAt: now,
    };
    this.prospectos.set(row.id, row);
    return row;
  }

  async updateProspectoForSuperadmin(callerId: string, prospectoId: string, estado: string | null, notas: string | null): Promise<ProspectoRow> {
    if (!this.platformSuperadmins.has(callerId)) throw new Error("forbidden");
    const current = this.prospectos.get(prospectoId);
    if (!current) throw new ProspectoNotFoundError();
    const updated: ProspectoRow = { ...current, estado: estado ?? current.estado, notas: notas ?? current.notas, updatedAt: new Date().toISOString() };
    this.prospectos.set(prospectoId, updated);
    return updated;
  }

  // Mismo rol de acceso total real por vertical que
  // core.ensure_demo_access_for_superadmin (ver la migración 0014) -- nunca un rol
  // inventado solo para esto.
  private static readonly ROL_DEMO_POR_VERTICAL: Record<string, string> = {
    hoteles: "owner",
    restaurantes: "owner",
    citas: "owner",
    licitaciones: "owner",
    despachos: "admin",
    rentas: "admin_gestora",
  };

  async ensureDemoAccessForSuperadmin(callerId: string, vertical: string): Promise<{ readonly organizationId: string; readonly slug: string }> {
    if (!this.platformSuperadmins.has(callerId)) throw new Error("forbidden");
    const verticalRole = InMemoryCoreRepository.ROL_DEMO_POR_VERTICAL[vertical];
    if (!verticalRole) throw new Error("vertical inválida");

    const slug = `demo-${vertical}`;
    let org = [...this.organizations.values()].find((o) => o.slug === slug);
    if (!org) {
      org = { id: randomUUID(), slug, name: `Demo — Vista previa (${vertical})`, vertical, status: "active", createdAt: new Date().toISOString() };
      this.organizations.set(org.id, org);
    }

    const yaMiembro = this.memberships.some((m) => m.userId === callerId && m.organizationId === org!.id);
    if (!yaMiembro) {
      this.memberships.push({ userId: callerId, organizationId: org.id, platformRole: "owner", verticalRole, propertyIds: null });
    }

    return { organizationId: org.id, slug: org.slug };
  }

  // ---- Suscripción SaaS propia de Atiende — ver el contrato completo (y el
  // porqué de cada método) en `core-repository.ts`. En memoria no hay ninguna
  // sesión/RLS que emular (mismo criterio que el resto de este archivo): solo
  // espeja la autorización que `core.get_organization_billing_for_checkout`
  // aplica DENTRO de la función SQL real. ----

  /** Primer 'owner' por antigüedad de membership — en memoria `this.memberships`
   *  ya está en orden de inserción (nunca se reordena), mismo criterio que
   *  `order by m.created_at asc limit 1` de la función SQL real. */
  private resolveOrganizationOwnerEmail(organizationId: string): string | null {
    const ownerMembership = this.memberships.find((m) => m.organizationId === organizationId && m.platformRole === "owner");
    if (!ownerMembership) return null;
    return this.staffById.get(ownerMembership.userId)?.email ?? null;
  }

  private buildOrganizationBillingRow(organizationId: string): OrganizationBillingRow {
    const org = this.organizations.get(organizationId);
    if (!org) throw new Error(`buildOrganizationBillingRow: organización inexistente "${organizationId}" (el caller debe chequear existencia antes de llamar esto).`);
    const billing = this.organizationBilling.get(organizationId);
    return {
      organizationId,
      vertical: org.vertical,
      ownerEmail: this.resolveOrganizationOwnerEmail(organizationId),
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: billing?.stripeSubscriptionId ?? null,
      priceId: billing?.priceId ?? null,
      seats: billing?.seats ?? 0,
      status: billing?.status ?? "sin_suscripcion",
      currentPeriodEnd: billing?.currentPeriodEnd ?? null,
    };
  }

  async getOrganizationBillingForCheckout(callerId: string, organizationId: string): Promise<OrganizationBillingRow> {
    if (!this.organizations.has(organizationId)) throw new OrganizationNotFoundError();
    const isOrgAdmin = this.memberships.some(
      (m) => m.organizationId === organizationId && m.userId === callerId && (m.platformRole === "owner" || m.platformRole === "admin"),
    );
    if (!isOrgAdmin && !this.platformSuperadmins.has(callerId)) throw new OrganizationBillingAccessDeniedError();
    return this.buildOrganizationBillingRow(organizationId);
  }

  async getOrganizationBillingForWebhook(organizationId: string): Promise<OrganizationBillingRow | null> {
    if (!this.organizations.has(organizationId)) return null;
    return this.buildOrganizationBillingRow(organizationId);
  }

  async upsertOrganizationBilling(input: UpsertOrganizationBillingInput): Promise<OrganizationBillingRow> {
    // Mismo candado que el `foreign key` real de `core.organization_billing.
    // organization_id` (ver la migración) -- nunca se inserta una fila de
    // billing huérfana.
    if (!this.organizations.has(input.organizationId)) throw new OrganizationNotFoundError();
    this.organizationBilling.set(input.organizationId, {
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      priceId: input.priceId,
      seats: input.seats,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd,
    });
    return this.buildOrganizationBillingRow(input.organizationId);
  }

  async markBillingWebhookEventSeen(eventId: string): Promise<BillingWebhookEventMark> {
    if (this.seenBillingWebhookEventIds.has(eventId)) return "duplicado";
    this.seenBillingWebhookEventIds.add(eventId);
    return "nuevo";
  }

  async getBillingEntityOrder(entityId: string): Promise<number | null> {
    return this.billingEntityOrder.has(entityId) ? this.billingEntityOrder.get(entityId)! : null;
  }

  async sealBillingEntityOrder(entityId: string, createdUnix: number): Promise<void> {
    this.billingEntityOrder.set(entityId, createdUnix);
  }
}
