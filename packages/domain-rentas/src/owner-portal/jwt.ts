// JWT de scope "propietario" -- vive DELIBERADAMENTE dentro de domain-rentas, NUNCA en
// @atiende/core-auth (ver diseño Fase 3 §1.2/§3). `AccessTokenClaims` de core-auth
// asume `org_id` singular + `vertical` + `property_ids`, que es justo lo que este actor
// NO tiene: su alcance (qué organizaciones/unidades/statements le pertenecen) se
// resuelve en vivo vía RLS (`owner_id = auth.uid()`), nunca vía un claim estático --
// mismo principio (ADR-004: "el rol/alcance real siempre se resuelve en vivo, nunca
// desde un claim potencialmente obsoleto") aplicado aquí a una identidad distinta.
//
// Regla de nombres explícita (diseño §1.2): "propietario"/"property owner" en TODO
// identificador nuevo de esta fase, nunca la palabra sola "owner" sin calificar --
// `PlatformRole` de @atiende/core-tenancy ya usa el valor "owner" como TECHO de rol de
// un STAFF (admin_gestora -> platformRole "owner"), algo completamente distinto de
// `rentas.owner` (el dueño real del inmueble). Mezclar ambos en un nombre/log sería el
// bug de colapso terminológico exacto que el diseño pide evitar.
//
// Secreto de firma DISTINTO al de staff (`RENTAS_OWNER_JWT_SECRET`, nunca
// `deps.env.jwtSecret`) -- defensa en profundidad barata: aunque un bug de routing
// algún día montara una ruta de staff bajo un middleware equivocado, un token de
// propietario firmado con otra clave simplemente no verifica ahí, sin depender de que
// nadie recuerde chequear el campo `type` del payload.
//
// `signAccessToken`/`verifyAccessToken` de core-auth NO se reutilizan (firman/verifican
// un `AccessTokenClaims` shape distinto) -- se duplican aquí las ~15 líneas de `jose`
// que hacen falta. Duplicación deliberada y barata: generalizar
// `core-auth::signAccessToken` para aceptar cualquier claims shape sería tocar el
// núcleo compartido para un caso de una sola vertical (ver diseño §7, condición de
// disparo explícita para cuándo SÍ ameritaría extraer algo genérico a core-auth).
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

export interface RentasPropertyOwnerAccessTokenClaims {
  readonly sub: string; // rentas.owner.id -- NUNCA un core.staff_user.id
  readonly email: string;
  readonly type: "rentas_property_owner_access";
}

export interface RentasPropertyOwnerRefreshTokenClaims {
  readonly sub: string;
  readonly type: "rentas_property_owner_refresh";
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export class RentasPropertyOwnerTokenInvalidError extends Error {}
export class RentasPropertyOwnerTokenExpiredError extends Error {}

export async function signRentasPropertyOwnerAccessToken(
  claims: Omit<RentasPropertyOwnerAccessTokenClaims, "type">,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: "rentas_property_owner_access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(claims.sub)
    .sign(secretKey(secret));
}

export async function signRentasPropertyOwnerRefreshToken(sub: string, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ type: "rentas_property_owner_refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(sub)
    .sign(secretKey(secret));
}

export async function verifyRentasPropertyOwnerAccessToken(token: string, secret: string): Promise<RentasPropertyOwnerAccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "rentas_property_owner_access") throw new RentasPropertyOwnerTokenInvalidError("El token no es un access token de propietario.");
    return payload as unknown as RentasPropertyOwnerAccessTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new RentasPropertyOwnerTokenExpiredError("El token expiró.");
    if (err instanceof RentasPropertyOwnerTokenInvalidError) throw err;
    throw new RentasPropertyOwnerTokenInvalidError("Token inválido.");
  }
}

export async function verifyRentasPropertyOwnerRefreshToken(token: string, secret: string): Promise<RentasPropertyOwnerRefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    if (payload.type !== "rentas_property_owner_refresh") throw new RentasPropertyOwnerTokenInvalidError("El token no es un refresh token de propietario.");
    return payload as unknown as RentasPropertyOwnerRefreshTokenClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new RentasPropertyOwnerTokenExpiredError("El refresh token expiró.");
    if (err instanceof RentasPropertyOwnerTokenInvalidError) throw err;
    throw new RentasPropertyOwnerTokenInvalidError("Refresh token inválido.");
  }
}
