// InMemoryCoreRepository — implementación real (no un mock) de `CoreRepository`
// respaldada por Maps, con las mismas restricciones de integridad que el DDL de
// `migrations/0001_core_schema.sql` (email único, membership por (userId, orgId)).
// Sirve para tests determinísticos de las rutas de login y como fallback dev/CI sin
// Postgres real — mismo rol que `InMemoryStateStore` en `@atiende/core-conversation`.
import type { CoreRepository, MembershipRow, StaffUserRow } from "./core-repository.ts";

export interface SeedOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly vertical: string;
}

export interface SeedMembership {
  readonly userId: string;
  readonly organizationId: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

export class InMemoryCoreRepository implements CoreRepository {
  private readonly staffById = new Map<string, StaffUserRow>();
  private readonly staffIdByEmail = new Map<string, string>();
  private readonly organizations = new Map<string, SeedOrganization>();
  private readonly memberships: SeedMembership[] = [];

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

  async findStaffByEmail(email: string): Promise<StaffUserRow | null> {
    const id = this.staffIdByEmail.get(email);
    return id ? (this.staffById.get(id) ?? null) : null;
  }

  async findStaffById(id: string): Promise<StaffUserRow | null> {
    return this.staffById.get(id) ?? null;
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
}
