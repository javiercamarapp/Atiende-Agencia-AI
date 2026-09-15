// ProductionRentasOwnerPortalRepository — adaptador de producción de
// `RentasOwnerPortalRepository`, envuelve `PostgresRentasOwnerPortalRepository`
// (@atiende/domain-rentas) construido sobre la sesión RLS por-request
// (`TenantDbSession`, ver ../deps.ts).
//
// Los 8 métodos del puerto delegan directo — incluyendo, desde la migración 013
// (`packages/domain-rentas/migrations/013_owner_portal_security_definer.sql`),
// `findOwnerCredentialByEmail`/`createPortalInvite`/`consumePortalInvite`: aunque
// `rentas.owner_credential` sigue sin otorgar SELECT/INSERT/UPDATE a `authenticated`
// (migración 006, solo `service_role`, que este monorepo no aprovisiona todavía), esos
// tres métodos ahora llaman funciones SQL `security definer` (mismo criterio exacto
// que `core.accept_staff_invite`, `packages/db/migrations/0002_staff_invite_schema.sql`)
// que corren con el privilegio del dueño de la función sobre la MISMA sesión
// por-request que abre `requireRentasOwnerSession`/`requirePropertyMembership` — nunca
// requieren `engine.admin`/`service_role` real. Ver el comentario de cabecera de
// `domain-rentas/src/owner-portal/postgres-repository.ts` para el detalle de qué
// verifica cada función (`create_owner_portal_invite`, en particular, reusa
// `core.has_property_access` para exigir que el staff invitante tenga acceso real a
// una property donde el propietario tiene una unidad — nunca confía solo en que la
// ruta HTTP ya lo validó).
import type {
  ConsumePortalInviteInput,
  FiltroOwnerPortalStatements,
  NewPortalInviteInput,
  OwnerCredentialForLogin,
  OwnerPortalOrganizacion,
  OwnerPortalProfileBase,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  RentasOwnerPortalRepository,
  RevokeOwnerRefreshTokenInput,
  UnidadPropietarioRecord,
} from "@atiende/domain-rentas";
import { PostgresRentasOwnerPortalRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";

export class ProductionRentasOwnerPortalRepository implements RentasOwnerPortalRepository {
  private readonly delegate: PostgresRentasOwnerPortalRepository;

  constructor(db: TenantDbSession) {
    this.delegate = new PostgresRentasOwnerPortalRepository(db);
  }

  findOwnerProfile(ownerId: string): Promise<OwnerPortalProfileBase | null> {
    return this.delegate.findOwnerProfile(ownerId);
  }

  listOwnerOrganizaciones(ownerId: string): Promise<readonly OwnerPortalOrganizacion[]> {
    return this.delegate.listOwnerOrganizaciones(ownerId);
  }

  listUnidadesPropietario(ownerId: string): Promise<readonly UnidadPropietarioRecord[]> {
    return this.delegate.listUnidadesPropietario(ownerId);
  }

  listOwnerStatementsPropietario(ownerId: string, filtro: FiltroOwnerPortalStatements): Promise<readonly OwnerPortalStatementSummary[]> {
    return this.delegate.listOwnerStatementsPropietario(ownerId, filtro);
  }

  findOwnerStatementDetallePropietario(ownerId: string, statementId: string): Promise<OwnerPortalStatementDetalle | null> {
    return this.delegate.findOwnerStatementDetallePropietario(ownerId, statementId);
  }

  findOwnerCredentialByEmail(email: string): Promise<OwnerCredentialForLogin | null> {
    return this.delegate.findOwnerCredentialByEmail(email);
  }

  createPortalInvite(input: NewPortalInviteInput): Promise<void> {
    return this.delegate.createPortalInvite(input);
  }

  consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> {
    return this.delegate.consumePortalInvite(input);
  }

  revokeOwnerRefreshToken(input: RevokeOwnerRefreshTokenInput): Promise<void> {
    return this.delegate.revokeOwnerRefreshToken(input);
  }

  isOwnerRefreshTokenRevoked(jti: string): Promise<boolean> {
    return this.delegate.isOwnerRefreshTokenRevoked(jti);
  }
}
