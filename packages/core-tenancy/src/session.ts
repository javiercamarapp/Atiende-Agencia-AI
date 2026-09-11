// Lógica pura de resolución de acceso por property, generalizada de
// `requireHotelMembership` (hoteles/apps/api/src/middleware.ts): "403 explícito
// (defensa en profundidad, además de RLS) si el usuario no pertenece a la property de
// la ruta o no tiene uno de los roles permitidos". Esta función es la MISMA regla,
// sin conocimiento de Hono/HTTP — `@atiende/core-auth` la envuelve en un middleware
// (ver core-auth/src/middleware.ts), pero la regla en sí vive aquí para poder probarse
// sin levantar un framework HTTP y para que cualquier otro llamador (worker, script de
// backoffice) la reutilice igual.
import type { Membership, PlatformRole, TenantSessionClaims, Vertical } from "./types.ts";

export class TenancyError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** El usuario no tiene ninguna fila de membership para esta organización. */
export class NotAMemberError extends TenancyError {
  constructor(userId: string, organizationId: string) {
    super(`el usuario "${userId}" no pertenece a la organización "${organizationId}".`, "not_a_member");
  }
}

/** El usuario es miembro de la organización pero su `propertyIds` no incluye la
 * property solicitada (y no es `null`, que da acceso a todas). */
export class PropertyAccessDeniedError extends TenancyError {
  readonly propertyId: string;

  constructor(userId: string, propertyId: string) {
    super(`el usuario "${userId}" no tiene acceso a la property "${propertyId}".`, "property_access_denied");
    this.propertyId = propertyId;
  }
}

/** El `platformRole` de la membership no está entre los roles permitidos para la acción. */
export class InsufficientPlatformRoleError extends TenancyError {
  readonly role: PlatformRole;
  readonly allowedRoles: readonly PlatformRole[];

  constructor(role: PlatformRole, allowedRoles: readonly PlatformRole[]) {
    super(
      `el rol de plataforma "${role}" no está entre los roles permitidos [${allowedRoles.join(", ")}] para esta acción.`,
      "insufficient_platform_role",
    );
    this.role = role;
    this.allowedRoles = allowedRoles;
  }
}

/**
 * Mismo criterio que `core.has_property_access` (política RLS estándar del núcleo,
 * ver docs/REQUISITOS.md): `propertyIds === null` es acceso a TODAS las properties de
 * la organización (equivalente a owner/admin de plataforma); en otro caso, la property
 * pedida debe estar en el array.
 */
export function hasPropertyAccess(membership: Membership, propertyId: string): boolean {
  return membership.propertyIds === null || membership.propertyIds.includes(propertyId);
}

/** Lanza `PropertyAccessDeniedError` si `hasPropertyAccess` es falso. Nunca degrada en
 * silencio — fail-closed, igual que `requireHotelMembership` hoy. */
export function assertPropertyAccess(membership: Membership, propertyId: string): void {
  if (!hasPropertyAccess(membership, propertyId)) {
    throw new PropertyAccessDeniedError(membership.userId, propertyId);
  }
}

/** Generaliza el chequeo de `allowedRoles` de `requireHotelMembership`: 403 explícito
 * si el `platformRole` de la membership no está en la lista permitida. Deliberadamente
 * solo mira `platformRole` (el techo común) — el chequeo de `verticalRole` fino vive en
 * cada `domain-<vertical>`, nunca aquí (ver comentario de `Membership.verticalRole`). */
export function assertPlatformRole(membership: Membership, allowedRoles: readonly PlatformRole[]): void {
  if (!allowedRoles.includes(membership.platformRole)) {
    throw new InsufficientPlatformRoleError(membership.platformRole, allowedRoles);
  }
}

/**
 * Construye los claims de sesión de tenant a partir de la membership YA verificada en
 * vivo contra la base de datos — nunca a partir del claim (potencialmente obsoleto)
 * del JWT. Mismo principio que ADR-004 de hoteles: "la autoridad real de org_id/
 * hotelIds para el resto del request es la membership verificada en este momento,
 * NUNCA el claim del JWT".
 *
 * `propertyId` es opcional: cuando la ruta ya resolvió una property concreta (patrón
 * `requireHotelMembership(hotelIdParam, ...)`), los claims quedan acotados a ESA sola
 * property (aunque la membership tenga acceso a más), igual que hoteles hace hoy
 * (`c.set("hotelIds", [hotelId])`) — evita que una query de negocio se filtre "de más"
 * solo porque el usuario tiene acceso amplio.
 */
export function buildTenantSessionClaims(
  membership: Membership,
  vertical: Vertical,
  propertyId?: string,
): TenantSessionClaims {
  if (propertyId !== undefined) {
    assertPropertyAccess(membership, propertyId);
  }
  return {
    userId: membership.userId,
    organizationId: membership.organizationId,
    vertical,
    propertyIds: propertyId !== undefined ? [propertyId] : membership.propertyIds,
  };
}
