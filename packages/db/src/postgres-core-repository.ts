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
  StaffInviteRow,
  StaffInviteStatus,
  StaffUserRow,
} from "./core-repository.ts";
import { StaffInviteInvalidError } from "./core-repository.ts";

interface StaffUserRawRow {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
  readonly password_hash: string | null;
  readonly created_via: StaffUserRow["createdVia"];
  readonly email_verified_at: string | null;
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
      `select id, email, full_name, password_hash, created_via, email_verified_at
       from core.staff_user where email = $1;`,
      [email],
    );
    return rows[0] ? mapStaff(rows[0]) : null;
  }

  async findStaffById(id: string): Promise<StaffUserRow | null> {
    const { rows } = await this.db.query<StaffUserRawRow>(
      `select id, email, full_name, password_hash, created_via, email_verified_at
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
}
