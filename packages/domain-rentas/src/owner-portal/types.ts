// Tipos de registro del portal de propietario (Fase 3) -- espejo, a nivel de tipos, de
// `types.ts` (owner statement de Fase 2), pero SIEMPRE enriquecidos con
// `organizationId`/`organizationName`: a diferencia de las rutas de staff (acotadas a
// UNA property vía `requirePropertyMembership`), el propietario ve datos de TODAS las
// organizaciones gestoras donde tiene presencia en una sola respuesta -- necesita saber
// a cuál pertenece cada fila (ver diseño §1.3-#5, §4).
import type { RangoFechas } from "../tipos.ts";
import type { LineaOwnerStatement, TotalesOwnerStatement } from "../finanzas/statement.ts";

export interface OwnerCredentialForLogin {
  readonly ownerId: string;
  readonly email: string;
  readonly passwordHash: string;
}

export interface OwnerPortalProfileBase {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
}

export interface OwnerPortalOrganizacion {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
}

export interface UnidadPropietarioRecord {
  readonly id: string;
  readonly name: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface OwnerPortalStatementSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly netoCentavos: number;
  readonly generadoEn: string;
}

export interface OwnerPortalStatementDetalle extends OwnerPortalStatementSummary {
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly motivoVersion: string | null;
}

/** Filtros opcionales de `GET /rentas/owner-portal/statements` -- nunca `ownerId`
 * (siempre resuelto server-side desde el JWT, ver diseño §4). */
export interface FiltroOwnerPortalStatements {
  readonly propertyId?: string;
  readonly desde?: string; // periodo_inicio >= desde (YYYY-MM-DD)
  readonly hasta?: string; // periodo_fin <= hasta (YYYY-MM-DD)
}

export interface NewPortalInviteInput {
  readonly ownerId: string;
  readonly tokenHash: string;
  readonly expiresAt: string; // ISO 8601
  readonly createdBy: string; // core.staff_user.id de quien invita
}

export interface ConsumePortalInviteInput {
  readonly tokenHash: string;
  readonly passwordHash: string;
  /** Instante de la request, inyectado explícito (nunca `new Date()` dentro del
   *  adaptador) -- para que la expiración se pueda probar de forma determinística. */
  readonly now: string; // ISO 8601
}

/** Hallazgo de auditoría (severidad ALTA, "el portal de propietario no tiene logout/
 * revocación real de sesión") -- mismo shape que
 * `@atiende/db::RevokeRefreshTokenInput` (staff), aplicado a `rentas.owner`. */
export interface RevokeOwnerRefreshTokenInput {
  readonly jti: string;
  readonly ownerId: string;
  readonly expiresAt: string; // ISO 8601
}
