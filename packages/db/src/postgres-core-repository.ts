// PostgresCoreRepository — adaptador de producción de `CoreRepository` +
// `CoreStaffRepository`, sobre el `TenantDbSession` genérico que ya define
// `@atiende/core-tenancy` (mismo contrato que consume `core-auth/src/middleware.ts`).
// Ejecuta las queries reales contra el esquema `core` de
// `migrations/0001_core_schema.sql`/`migrations/0002_staff_invite_schema.sql`.
//
// Implementa AMBAS interfaces con la MISMA clase (ver comentario de cabecera en
// `core-repository.ts`): esta clase no abre sesión por sí sola (mismo criterio que ya
// documentaba este archivo), así que es indistinta a si `db` es una sesión de sistema
// (`userId: null`, usada por `ProductionCoreRepository` para `findStaffInviteByTokenHash`/
// `acceptStaffInvite`, igual que ya hace para login) o una sesión real por-request con
// `auth.uid()` del staff autenticado (usada directo por las rutas de invitación vía
// `AppDeps.coreStaffRepo`, ver `apps/api/src/production/deps.ts`) — quien decide eso es
// el caller, nunca esta clase.
import type { TenantDbSession } from "@atiende/core-tenancy";
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
  StaffInviteStatus,
  StaffUserRow,
  SuperadminOrganizationRow,
} from "./core-repository.ts";
import { MembershipRoleUpdateError, StaffInviteInvalidError } from "./core-repository.ts";

interface StaffUserRawRow {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly password_hash: string | null;
  readonly created_via: StaffUserRow["createdVia"];
  readonly email_verified_at: string | null;
  readonly sessions_revoked_at: string | null;
}

interface MembershipRawRow {
  readonly organization_id: string;
  readonly slug: string;
  readonly name: string;
  readonly vertical: string;
  readonly platform_role: MembershipRow["platformRole"];
  readonly vertical_role: string;
  readonly property_ids: readonly string[] | null;
}

interface StaffInviteRawRow {
  readonly id: string;
  readonly email: string;
  readonly organization_id: string;
  readonly platform_role: StaffInviteRow["platformRole"];
  readonly vertical_role: string;
  readonly property_ids: readonly string[] | null;
  readonly status: StaffInviteStatus;
  readonly invited_by: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly accepted_by: string | null;
  readonly created_at: string;
}

interface OrganizationMemberRawRow {
  readonly user_id: string;
  readonly email: string;
  readonly full_name: string;
  readonly property_ids: readonly string[] | null;
}

interface OrganizationMemberWithRoleRawRow {
  readonly user_id: string;
  readonly email: string;
  readonly full_name: string;
  readonly platform_role: OrganizationMemberWithRoleRow["platformRole"];
  readonly vertical_role: string;
  readonly property_ids: readonly string[] | null;
}

function mapOrganizationMemberWithRole(row: OrganizationMemberWithRoleRawRow): OrganizationMemberWithRoleRow {
  return {
    userId: row.user_id,
    email: row.email,
    fullName: row.full_name,
    platformRole: row.platform_role,
    verticalRole: row.vertical_role,
    propertyIds: row.property_ids,
  };
}

interface AcceptStaffInviteRawRow {
  readonly staff_id: string;
  readonly email: string;
  readonly organization_id: string;
  readonly vertical: string;
  readonly platform_role: AcceptStaffInviteResult["platformRole"];
  readonly vertical_role: string;
  readonly property_ids: readonly string[] | null;
}

function mapStaff(row: StaffUserRawRow): StaffUserRow {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    createdVia: row.created_via,
    emailVerifiedAt: row.email_verified_at,
    sessionsRevokedAt: row.sessions_revoked_at,
  };
}

function mapStaffInvite(row: StaffInviteRawRow): StaffInviteRow {
  return {
    id: row.id,
    email: row.email,
    organizationId: row.organization_id,
    platformRole: row.platform_role,
    verticalRole: row.vertical_role,
    propertyIds: row.property_ids,
    status: row.status,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
  };
}

export class PostgresCoreRepository implements CoreRepository, CoreStaffRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findStaffByEmail(email: string): Promise<StaffUserRow | null> {
    const { rows } = await this.db.query<StaffUserRawRow>(
      `select id, email, full_name, password_hash, created_via, email_verified_at, sessions_revoked_at
       from core.staff_user where email = $1;`,
      [email],
    );
    return rows[0] ? mapStaff(rows[0]) : null;
  }

  async findStaffById(id: string): Promise<StaffUserRow | null> {
    const { rows } = await this.db.query<StaffUserRawRow>(
      `select id, email, full_name, password_hash, created_via, email_verified_at, sessions_revoked_at
       from core.staff_user where id = $1;`,
      [id],
    );
    return rows[0] ? mapStaff(rows[0]) : null;
  }

  async findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]> {
    const { rows } = await this.db.query<MembershipRawRow>(
      `select m.organization_id, o.slug, o.name, o.vertical, m.platform_role, m.vertical_role, m.property_ids
       from core.membership m
       join core.organization o on o.id = m.organization_id
       where m.user_id = $1
       order by o.name asc;`,
      [userId],
    );
    return rows.map((row) => ({
      organizationId: row.organization_id,
      organizationSlug: row.slug,
      organizationName: row.name,
      vertical: row.vertical,
      platformRole: row.platform_role,
      verticalRole: row.vertical_role,
      propertyIds: row.property_ids,
    }));
  }

  // ---- CoreStaffRepository — RLS real de `core.staff_invite` es la autoridad
  // (owner/admin de la organización), esta clase solo ejecuta el SQL. ----

  async createStaffInvite(input: CreateStaffInviteInput): Promise<StaffInviteRow> {
    const { rows } = await this.db.query<StaffInviteRawRow>(
      `insert into core.staff_invite (email, organization_id, platform_role, vertical_role, property_ids, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, email, organization_id, platform_role, vertical_role, property_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at;`,
      [input.email, input.organizationId, input.platformRole, input.verticalRole, input.propertyIds, input.tokenHash, input.invitedBy, input.expiresAt],
    );
    const row = rows[0];
    if (!row) throw new Error("core.staff_invite: insert no devolvió fila (no debería pasar nunca).");
    return mapStaffInvite(row);
  }

  async listPendingStaffInvites(organizationId: string): Promise<readonly StaffInviteRow[]> {
    const { rows } = await this.db.query<StaffInviteRawRow>(
      `select id, email, organization_id, platform_role, vertical_role, property_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at
       from core.staff_invite
       where organization_id = $1 and status = 'pending'
       order by created_at desc;`,
      [organizationId],
    );
    return rows.map(mapStaffInvite);
  }

  async revokeStaffInvite(id: string, organizationId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(
      `update core.staff_invite set status = 'revoked'
       where id = $1 and organization_id = $2 and status = 'pending'
       returning id;`,
      [id, organizationId],
    );
    return rows.length > 0;
  }

  // Fase 12 — hallazgo de auditoría ("asignar repartidor a un pedido no tiene UI"):
  // `core.membership` restringe SELECT a `user_id = auth.uid()` (política "staff ve su
  // propia membership", `0001_core_schema.sql`) -- una query directa aquí NUNCA vería
  // las filas de OTRO miembro, aunque este método SÍ corra sobre la sesión real
  // por-request (`auth.uid()` = el staff autenticado que llama, a diferencia de
  // `findMembershipsByUserId` de arriba cuando lo invoca `ProductionCoreRepository` en
  // sesión de sistema). Por eso usa la función `security definer`
  // `core.list_org_members_by_vertical_role` (`0004_list_org_members_by_vertical_
  // role.sql`, mismo patrón exacto que `core.has_property_access`/
  // `core.accept_staff_invite`): valida DENTRO de la función que quien llama
  // (`auth.uid()`) es TAMBIÉN miembro de esa misma organización -- defensa en
  // profundidad real, no una promesa de la capa TS -- y solo entonces devuelve
  // id/email/nombre/propertyIds de los miembros con el `vertical_role` exacto pedido.
  async listMembersByVerticalRole(organizationId: string, verticalRole: string): Promise<readonly OrganizationMemberRow[]> {
    const { rows } = await this.db.query<OrganizationMemberRawRow>(
      `select user_id, email, full_name, property_ids from core.list_org_members_by_vertical_role($1, $2);`,
      [organizationId, verticalRole],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      propertyIds: row.property_ids,
    }));
  }

  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto") — mismo criterio EXACTO
  // que `listMembersByVerticalRole` de arriba (función `security definer`,
  // `core.list_org_members`, ver `migrations/0007_update_membership_role.sql`):
  // RLS de `core.membership` restringe SELECT a la fila propia, así que sin esta
  // función un owner/admin autenticado real nunca vería la fila de un compañero.
  async listOrgMembers(organizationId: string): Promise<readonly OrganizationMemberWithRoleRow[]> {
    const { rows } = await this.db.query<OrganizationMemberWithRoleRawRow>(`select * from core.list_org_members($1);`, [organizationId]);
    return rows.map(mapOrganizationMemberWithRole);
  }

  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA) — ver el
  // comentario de cabecera de `core.update_membership_role`
  // (`migrations/0007_update_membership_role.sql`) para la jerarquía real que la
  // función SQL aplica (la AUTORIDAD real, nunca solo la capa TS). Igual criterio de
  // traducción de excepción que `acceptStaffInvite` de abajo: SQLSTATE P0001 ->
  // error tipado — a diferencia de `StaffInviteInvalidError` (mensaje único a
  // propósito), aquí se preserva el mensaje real (ver el comentario de
  // `MembershipRoleUpdateError`, ninguno de sus casos es sensible de ocultar).
  async updateMemberVerticalRole(
    organizationId: string,
    targetUserId: string,
    newPlatformRole: "owner" | "admin" | "member" | "viewer",
    newVerticalRole: string,
  ): Promise<OrganizationMemberWithRoleRow> {
    try {
      const { rows } = await this.db.query<OrganizationMemberWithRoleRawRow>(`select * from core.update_membership_role($1, $2, $3, $4);`, [
        organizationId,
        targetUserId,
        newPlatformRole,
        newVerticalRole,
      ]);
      const row = rows[0];
      if (!row) throw new MembershipRoleUpdateError("el staff indicado no pertenece a esta organización.");
      return mapOrganizationMemberWithRole(row);
    } catch (err) {
      if (err instanceof MembershipRoleUpdateError) throw err;
      const pgErr = err as { code?: string; message?: string } | null;
      if (pgErr?.code === "P0001") throw new MembershipRoleUpdateError(pgErr.message ?? "No se pudo cambiar el rol de ese staff.");
      throw err;
    }
  }

  // ---- CoreRepository — sesión de sistema (igual que login), ver comentario de
  // cabecera de `core-repository.ts`. ----

  async findStaffInviteByTokenHash(tokenHash: string): Promise<StaffInviteRow | null> {
    const { rows } = await this.db.query<StaffInviteRawRow>(
      `select id, email, organization_id, platform_role, vertical_role, property_ids, status, invited_by, expires_at, accepted_at, accepted_by, created_at
       from core.staff_invite where token_hash = $1;`,
      [tokenHash],
    );
    return rows[0] ? mapStaffInvite(rows[0]) : null;
  }

  async acceptStaffInvite(input: AcceptStaffInviteInput): Promise<AcceptStaffInviteResult> {
    try {
      const { rows } = await this.db.query<AcceptStaffInviteRawRow>(`select * from core.accept_staff_invite($1, $2, $3);`, [
        input.tokenHash,
        input.fullName,
        input.passwordHash,
      ]);
      const row = rows[0];
      if (!row) throw new StaffInviteInvalidError();
      return {
        staffId: row.staff_id,
        email: row.email,
        organizationId: row.organization_id,
        vertical: row.vertical,
        platformRole: row.platform_role,
        verticalRole: row.vertical_role,
        propertyIds: row.property_ids,
      };
    } catch (err) {
      // `core.accept_staff_invite` lanza una excepción SQL con SQLSTATE P0001
      // (`raise exception`) para los 3 casos de token inválido (ver la migración) —
      // se traduce aquí al mismo error tipado que usa el adaptador en memoria, para
      // que la ruta HTTP nunca tenga que distinguir "vengo de Postgres" de "vengo de
      // InMemory".
      if (err instanceof StaffInviteInvalidError) throw err;
      const code = (err as { code?: string } | null)?.code;
      if (code === "P0001") throw new StaffInviteInvalidError();
      throw err;
    }
  }

  // ---- Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles") — sesión de sistema (igual que login/accept-invite arriba). Ambas rutas
  // pasan por funciones SQL `security definer` (`migrations/0003_refresh_token_
  // revocation.sql`) por el MISMO motivo que `core.accept_staff_invite`: el rol
  // `authenticated` sin `auth.uid()` (sesión de sistema) no tiene ningún GRANT directo
  // sobre `core.revoked_refresh_token`. ----

  async revokeRefreshToken(input: RevokeRefreshTokenInput): Promise<void> {
    await this.db.query(`select core.revoke_refresh_token($1, $2, $3);`, [input.jti, input.userId, input.expiresAt]);
  }

  async isRefreshTokenRevoked(jti: string): Promise<boolean> {
    const { rows } = await this.db.query<{ revoked: boolean }>(`select core.is_refresh_token_revoked($1) as revoked;`, [jti]);
    return rows[0]?.revoked ?? false;
  }

  // ---- Hallazgo de auditoría (rubro 2, severidad ALTA, "no hay forma de invalidar
  // sesiones activas de un usuario") — ver `migrations/0006_revoke_all_sessions.sql`.
  // `security definer`, mismo motivo/mismo patrón exacto que `revokeRefreshToken`
  // arriba: `authenticated` solo tiene GRANT de SELECT sobre `core.staff_user`, nunca
  // UPDATE (ver `0001_core_schema.sql`). ----

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.db.query(`select core.revoke_all_refresh_tokens($1);`, [userId]);
  }

  async findStaffByGoogleSub(sub: string): Promise<StaffUserRow | null> {
    const { rows } = await this.db.query<StaffUserRawRow>(
      `select id, email, full_name, password_hash, created_via, email_verified_at, sessions_revoked_at
       from core.find_staff_by_google_sub($1);`,
      [sub],
    );
    return rows[0] ? mapStaff(rows[0]) : null;
  }

  async linkGoogleIdentity(input: { readonly staffId: string; readonly sub: string; readonly email: string }): Promise<void> {
    await this.db.query(`select core.link_google_identity($1, $2, $3);`, [input.staffId, input.sub, input.email]);
  }

  async createMagicLinkToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    await this.db.query(`select core.create_magic_link_token($1, $2, $3);`, [input.staffId, input.tokenHash, input.expiresAt]);
  }

  async consumeMagicLinkToken(tokenHash: string): Promise<StaffUserRow | null> {
    const { rows } = await this.db.query<StaffUserRawRow>(
      `select id, email, full_name, password_hash, created_via, email_verified_at, sessions_revoked_at
       from core.consume_magic_link_token($1);`,
      [tokenHash],
    );
    return rows[0] ? mapStaff(rows[0]) : null;
  }

  async isPlatformSuperadmin(staffId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ is_platform_superadmin: boolean }>(`select core.is_platform_superadmin($1) as is_platform_superadmin;`, [staffId]);
    return rows[0]?.is_platform_superadmin ?? false;
  }

  async listAllOrganizationsForSuperadmin(callerId: string): Promise<readonly SuperadminOrganizationRow[]> {
    const { rows } = await this.db.query<{ id: string; vertical: string; name: string; slug: string; status: "trial" | "active" | "suspended"; created_at: string }>(
      `select id, vertical, name, slug, status, created_at from core.list_all_organizations_for_superadmin($1);`,
      [callerId],
    );
    return rows.map((r) => ({ id: r.id, vertical: r.vertical, name: r.name, slug: r.slug, status: r.status, createdAt: r.created_at }));
  }

  async countStaffByOrganizationForSuperadmin(callerId: string): Promise<ReadonlyMap<string, number>> {
    const { rows } = await this.db.query<{ organization_id: string; staff_count: string }>(
      `select organization_id, staff_count from core.count_staff_by_organization_for_superadmin($1);`,
      [callerId],
    );
    return new Map(rows.map((r) => [r.organization_id, Number(r.staff_count)]));
  }
}
