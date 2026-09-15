// JWT propio con `jose` (HS256), exp corta + refresh — mismo patrón que ADR-004 de
// hoteles (hoteles/apps/api/src/lib/jwt.ts), generalizado a las 5 verticales de
// `@atiende/core-tenancy`.
//
// Los claims son informativos/UX — la autorización real SIEMPRE se re-resuelve contra
// `core.membership` en vivo (ver middleware.ts `requirePropertyMembership`), nunca
// confiando en un claim de rol/alcance embebido que podría quedar obsoleto entre el
// login y la acción. Este es el MISMO principio que hoteles ya aplica hoy, solo que
// generalizado (antes: `hotel_ids`, ahora: `property_ids`; se añade `vertical` porque
// un token ahora puede corresponder a cualquiera de las 5 verticales, no solo hoteles).
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Vertical } from "@atiende/core-tenancy";

export interface AccessTokenClaims {
  readonly sub: string; // userId
  /** UNA sola organización activa por token — un usuario con varias organizaciones
   * re-emite token al cambiar de organización vía POST /auth/select-org (mismo patrón
   * que hoteles ya usa para multi-hotel). */
  readonly org_id: string;
  readonly vertical: Vertical;
  /** generaliza "hotel_ids"; null = todas las properties de la organización. */
  readonly property_ids: string[] | null;
  readonly email: string;
  readonly type: "access";
}

export interface RefreshTokenClaims {
  readonly sub: string;
  /** Identificador único del token (RFC 7519 `jti`) — hallazgo de auditoría (severidad
   * ALTA, "sin logout explícito en el panel de hoteles"): antes de esta pieza el
   * refresh token no tenía ningún identificador con el que un endpoint de logout
   * pudiera revocarlo de forma selectiva sin invalidar TODOS los refresh tokens del
   * usuario. Se persiste en `core.revoked_refresh_token` (jti, no el JWT completo)
   * cuando el staff cierra sesión — ver `apps/api/src/routes/auth.ts::/auth/logout`
   * y `@atiende/db::CoreRepository.revokeRefreshToken`. */
  readonly jti: string;
  /** Epoch seconds (`exp` estándar de JWT) — jose ya lo agrega al payload por
   * `setExpirationTime`; se declara aquí para que el caller de /auth/logout pueda
   * calcular `expires_at` de la fila de revocación sin volver a decodificar el JWT a
   * mano. */
  readonly exp: number;
  /** Epoch seconds (`iat` estándar de JWT) — jose ya lo agrega al payload por
   * `setIssuedAt()` (ver `signRefreshToken` abajo); se declara aquí (hallazgo de
   * auditoría, rubro 2, severidad ALTA: "no hay forma de invalidar sesiones activas
   * de un usuario") para que POST /auth/refresh pueda rechazar un refresh token
   * emitido ANTES de `core.staff_user.sessions_revoked_at` — el corte que
   * POST /auth/revoke-sessions establece para invalidar TODOS los refresh tokens de
   * un usuario de una sola vez, sin necesitar enumerar sus `jti` individuales (ver
   * `packages/db/migrations/0006_revoke_all_sessions.sql`). */
  readonly iat: number;
  readonly type: "refresh";
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export class TokenInvalidError extends Error {}
export class TokenExpiredError extends Error {}

export async function signAccessToken(
  claims: Omit<AccessTokenClaims, "type">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(claims.sub)
    .sign(secretKey(secret));
}

export async function signRefreshToken(sub: string, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(sub)
    .setJti(randomUUID())
    .sign(secretKey(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "access") throw new TokenInvalidError("El token no es un access token.");
    return payload as unknown as AccessTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError("El token expiró.");
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError("Token inválido.");
  }
}

export async function verifyRefreshToken(token: string, secret: string): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "refresh") throw new TokenInvalidError("El token no es un refresh token.");
    return payload as unknown as RefreshTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError("El refresh token expiró.");
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError("Refresh token inválido.");
  }
}
