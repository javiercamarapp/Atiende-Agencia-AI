// PostgresCoreRepository — adaptador de producción de `CoreRepository`, sobre el
// `TenantDbSession` genérico que ya define `@atiende/core-tenancy` (mismo contrato que
// consume `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `core` de `migrations/0001_core_schema.sql`.
//
// Se abre siempre vía `TenancyEngine.withAppSession({ userId: null }, ...)` (sesión
// de sistema, sin `auth.uid()`) porque login ocurre ANTES de que exista una sesión
// autenticada — no hay `auth.uid()` que las policies de `core.staff_user` puedan
// evaluar todavía. Mismo principio que ADR-003 de hoteles: "brecha declarada", el
// admin client nunca sirve datos de negocio ya autenticados, solo esta resolución de
// credenciales pre-sesión.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { CoreRepository, MembershipRow, StaffUserRow } from "./core-repository.ts";

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

export class PostgresCoreRepository implements CoreRepository {
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
}
