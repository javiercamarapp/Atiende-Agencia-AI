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
  CoreRepository,
  CoreStaffRepository,
  CreateStaffInviteInput,
  MembershipRow,
  OrganizationMemberRow,
  OrganizationMemberWithRoleRow,
  RevokeRefreshTokenInput,
  StaffInviteRow,
  StaffUserRow,
  SuperadminOrganizationRow,
} from "./core-repository.ts";
import { MembershipRoleUpdateError, StaffInviteInvalidError } from "./core-repository.ts";

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
  // Back office de plataforma — mismo dato que `core.platform_superadmin`.
  private readonly platformSuperadmins = new Set<string>();

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
}
