// ProductionRentasOwnerPortalRepository — adaptador real de `RentasOwnerPortalRepository`
// para producción, envuelve `PostgresRentasOwnerPortalRepository` (@atiende/domain-rentas)
// construido sobre la sesión RLS por-request (`TenantDbSession`, ver ../deps.ts).
//
// Los 5 métodos de solo lectura del portal (findOwnerProfile/listOwnerOrganizaciones/
// listUnidadesPropietario/listOwnerStatementsPropietario/
// findOwnerStatementDetallePropietario) delegan directo — funcionan correctamente
// contra RLS real con la sesión que abre `requireRentasOwnerSession`
// (`engine.withAppSession({ userId: ownerId }, ...)`, ver
// routes/verticals/rentas/owner-portal.ts).
//
// Los otros 3 (findOwnerCredentialByEmail/createPortalInvite/consumePortalInvite) leen
// o escriben `rentas.owner_credential`, que la migración 006 NUNCA otorga en
// SELECT/INSERT/UPDATE a `authenticated` -- solo a `service_role` (ver advertencia de
// cabecera de domain-rentas/src/owner-portal/postgres-repository.ts). Este monorepo NO
// provisiona todavía una conexión de `service_role` real (`ManagedPostgresEngine.admin`
// es el MISMO rol de mínimo privilegio que `withAppSession`, sin claims -- nunca
// `service_role`, ver packages/db/src/managed-postgres-engine.ts) -- exactamente el
// mismo tipo de gap que ya cubre `production/not-ready.ts` para `hotelesPaymentsPort`/
// `despachosAuditSink` (adaptador real existe, falta la infraestructura de privilegio
// que lo respalde), pero acotado aquí a SOLO estos 3 métodos de un puerto que por lo
// demás SÍ está completo. En vez de dejar a estos 3 golpear Postgres real y fallar con
// un "permission denied for table" críptico (o, peor, deslizar `engine.admin` y
// arriesgar un comportamiento silenciosamente incorrecto si las políticas cambiaran),
// fallan aquí con el mismo error explícito y accionable que el resto del código de
// producción no listo -- mientras la decisión de aprovisionar `service_role` no se
// tome (fuera de alcance de este cambio: es infraestructura de conexión, no el gap de
// sesión-por-request que este cambio sí resuelve).
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
  UnidadPropietarioRecord,
} from "@atiende/domain-rentas";
import { PostgresRentasOwnerPortalRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { notProductionReady } from "./not-ready.ts";

function requirePrivilegedSession<T extends object>(methodName: string): T {
  return notProductionReady<T>(
    `rentasOwnerPortalRepo.${methodName} (requiere una sesión de service_role -- ver production/rentas-owner-portal-repository.ts)`,
  );
}

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
    return requirePrivilegedSession<{ findOwnerCredentialByEmail(email: string): Promise<OwnerCredentialForLogin | null> }>("findOwnerCredentialByEmail").findOwnerCredentialByEmail(email);
  }

  createPortalInvite(input: NewPortalInviteInput): Promise<void> {
    return requirePrivilegedSession<{ createPortalInvite(input: NewPortalInviteInput): Promise<void> }>("createPortalInvite").createPortalInvite(input);
  }

  consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> {
    return requirePrivilegedSession<{ consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null> }>("consumePortalInvite").consumePortalInvite(input);
  }
}
