// Token de step-up: prueba de que el usuario acaba de pasar un segundo factor (TOTP o
// codigo de respaldo) para UNA clase de accion sensible. JWT HS256 con `type:
// "step_up"`, distinto de "access"/"refresh" (`verifyAccessToken` lo rechaza por su
// claim `type`, y `verifyContractStepUpToken` rechaza access/refresh), vida corta (5 min).
//
// Atado a: usuario (`sub`), organizacion (`org`) y alcance (`scope`). Un token de
// step-up emitido para el contrato de una organizacion no sirve en otra ni para otro
// alcance. Es sin estado (no se marca como usado): la ventana corta y el atado a
// usuario+organizacion+alcance son el limite; las transiciones quedan ademas en la
// bitacora con el actor.
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { TokenExpiredError, TokenInvalidError } from "./jwt.ts";

export const STEP_UP_TTL_SECONDS = 5 * 60;

/** Alcances conocidos. Se agregan aqui, nunca como cadena libre en una ruta. */
export type StepUpScope = "contract_sensitive";

export interface StepUpClaims {
  readonly sub: string;
  readonly org: string;
  readonly scope: StepUpScope;
  readonly type: "step_up";
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(`step-up:${secret}`);
}

export async function signContractStepUpToken(
  input: { readonly userId: string; readonly organizationId: string; readonly scope: StepUpScope },
  secret: string,
  ttlSeconds: number = STEP_UP_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ org: input.organizationId, scope: input.scope, type: "step_up" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setSubject(input.userId)
    .sign(key(secret));
}

/** Lanza `TokenInvalidError`/`TokenExpiredError`; nunca devuelve claims de otro usuario/org/alcance. */
export async function verifyContractStepUpToken(
  token: string,
  secret: string,
  expected: { readonly userId: string; readonly organizationId: string; readonly scope: StepUpScope },
): Promise<StepUpClaims> {
  try {
    const { payload } = await jwtVerify(token, key(secret));
    if (payload.type !== "step_up") throw new TokenInvalidError("No es un token de step-up.");
    if (payload.sub !== expected.userId || payload.org !== expected.organizationId || payload.scope !== expected.scope) {
      throw new TokenInvalidError("El token de step-up no corresponde a esta accion.");
    }
    return payload as unknown as StepUpClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError("El token de step-up expiro.");
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError("Token de step-up invalido.");
  }
}
