// Puerto de acceso a `core.staff_user`/`core.membership`/`core.organization`, para
// las rutas núcleo de login (`POST /auth/login`, `/auth/refresh`, `/auth/me`,
// `/auth/select-org` — ver diseño Fase 1 §5: "no son de domain-restaurantes, son
// núcleo compartido, igual patrón que hoteles apps/api/src/routes/auth.ts").
//
// Mismo patrón dual de adaptador que ya usa `@atiende/core-conversation`
// (`InMemoryStateStore`/`PostgresStateStore` implementando el mismo `StateStore`):
// un puerto TS explícito en vez de exponer `TenantDbSession.query(sql, params)` crudo
// en cada caller, para que la lógica de negocio (issueSession, etc.) se pruebe con un
// adaptador real en memoria sin requerir Postgres — packages/db no tiene todavía
// motor de conexión (PGlite/embedded-postgres), ver packages/db/README.md.

export interface StaffUserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string | null;
  readonly createdVia: "seed" | "invite" | "registro_autoservicio" | "google";
  readonly emailVerifiedAt: string | null;
}

export interface MembershipRow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly vertical: string;
  readonly platformRole: "owner" | "admin" | "member" | "viewer";
  readonly verticalRole: string;
  readonly propertyIds: readonly string[] | null;
}

export interface CoreRepository {
  findStaffByEmail(email: string): Promise<StaffUserRow | null>;
  findStaffById(id: string): Promise<StaffUserRow | null>;
  findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]>;
}
