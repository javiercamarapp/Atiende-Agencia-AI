// Puerto de acceso al portal de propietario (Fase 3) -- mismo patrón dual de adaptador
// que `RentasRepository`/`CoreRepository`: un puerto TS explícito, nunca
// `TenantDbSession.query(sql, params)` crudo expuesto a cada caller, para que la lógica
// de las rutas se pruebe con un adaptador en memoria real sin requerir Postgres.
//
// TODOS los métodos de lectura de negocio (`findOwnerProfile`/`listOwnerOrganizaciones`/
// `listUnidadesPropietario`/`listOwnerStatementsPropietario`/
// `findOwnerStatementDetallePropietario`) toman `ownerId` explícito -- NUNCA leído de un
// parámetro controlado por el cliente (path/query/body), siempre de `c.get("ownerId")`
// puesto por `requireRentasOwnerSession` desde el JWT ya verificado (ver diseño §4).
// Esto es la MISMA disciplina que el resto del monorepo ya aplica (`propertyId`
// explícito en cada método de `RentasRepository` pese a que `core.has_property_access`
// también filtra vía RLS) -- defensa en profundidad, nunca la única capa.
//
// `findOwnerCredentialByEmail`/`createPortalInvite`/`consumePortalInvite` tocan
// `rentas.owner_credential`, que NUNCA otorga SELECT a `authenticated` (ver migración
// 006). Resuelto en la migración 013 (`013_owner_portal_security_definer.sql`) con 3
// funciones SQL `security definer` -- mismo criterio exacto que `core.accept_staff_invite`
// (`packages/db/migrations/0002_staff_invite_schema.sql`) -- así que el adaptador
// Postgres real (`PostgresRentasOwnerPortalRepository`) sí puede construirse sobre la
// MISMA sesión RLS por-request que los otros cinco métodos (`c.get("db")`); ver el
// comentario de cabecera de `postgres-repository.ts` para el detalle de qué verifica
// cada función.
import type {
  ConsumePortalInviteInput,
  FiltroOwnerPortalStatements,
  NewPortalInviteInput,
  OwnerCredentialForLogin,
  OwnerPortalOrganizacion,
  OwnerPortalProfileBase,
  OwnerPortalStatementDetalle,
  OwnerPortalStatementSummary,
  RevokeOwnerRefreshTokenInput,
  UnidadPropietarioRecord,
} from "./types.ts";

export interface RentasOwnerPortalRepository {
  findOwnerCredentialByEmail(email: string): Promise<OwnerCredentialForLogin | null>;
  findOwnerProfile(ownerId: string): Promise<OwnerPortalProfileBase | null>;
  listOwnerOrganizaciones(ownerId: string): Promise<readonly OwnerPortalOrganizacion[]>;
  listUnidadesPropietario(ownerId: string): Promise<readonly UnidadPropietarioRecord[]>;
  listOwnerStatementsPropietario(ownerId: string, filtro: FiltroOwnerPortalStatements): Promise<readonly OwnerPortalStatementSummary[]>;
  findOwnerStatementDetallePropietario(ownerId: string, statementId: string): Promise<OwnerPortalStatementDetalle | null>;
  /** Genera la invitación (§5) -- la hace STAFF, nunca el propietario. Un
   *  `ownerId` solo puede tener UNA invitación pendiente a la vez: crear una nueva
   *  reemplaza cualquier token previo sin consumir (mismo criterio que un "reenviar
   *  invitación"). */
  createPortalInvite(input: NewPortalInviteInput): Promise<void>;
  /** Consume el token de un solo uso: si es válido y no expiró, fija/actualiza
   *  `password_hash` y limpia el token (nunca reutilizable) -- `null` si el token no
   *  existe, ya fue consumido, o expiró. */
  consumePortalInvite(input: ConsumePortalInviteInput): Promise<{ ownerId: string } | null>;
  /** Hallazgo de auditoría (severidad ALTA, "el portal de propietario no tiene
   *  logout/revocación real de sesión") -- mismo par de métodos que
   *  `@atiende/db::CoreRepository.revokeRefreshToken`/`isRefreshTokenRevoked`,
   *  aplicado a `rentas.owner` (ver ./jwt.ts, `RentasPropertyOwnerRefreshTokenClaims.jti`). */
  revokeOwnerRefreshToken(input: RevokeOwnerRefreshTokenInput): Promise<void>;
  isOwnerRefreshTokenRevoked(jti: string): Promise<boolean>;
}
