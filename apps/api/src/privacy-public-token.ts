// Codigos y enlaces de la privacidad publica del huesped de hoteles (H-30). Todo se firma con HMAC-SHA256 y una llave
// derivada del secreto interno con etiqueta propia (sin variables de entorno nuevas; un token de otra superficie nunca
// valida aqui).
//   - Codigo de verificacion de una solicitud ARCO: 6 digitos; a la base solo llega su HMAC ligado al id de la solicitud.
//   - Enlace "mis datos": `m1.<payload base64url>.<firma>`, de vida corta, ligado a organizacion + solicitud. NO contiene
//     nombre, correo ni datos del huesped; la base revalida que la solicitud siga siendo de acceso procedente.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const ARCO_CODE_TTL_SECONDS = 15 * 60;
export const MIS_DATOS_TTL_SECONDS = 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function privacyPublicKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/hoteles/privacidad-publica/v1").digest();
}

export function generateArcoCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashArcoCode(key: Buffer, requestId: string, code: string): string {
  return createHmac("sha256", key).update(`arco-code:${requestId}:${code}`).digest("hex");
}

export interface MisDatosClaims {
  /** organization_id */
  readonly org: string;
  /** id de la solicitud ARCO de acceso */
  readonly req: string;
  readonly iat: number;
  readonly exp: number;
}

export function issueMisDatosToken(key: Buffer, organizationId: string, requestId: string, nowMs: number = Date.now()): { token: string; expiresAt: string } {
  const iat = Math.floor(nowMs / 1000);
  const claims: MisDatosClaims = { org: organizationId, req: requestId, iat, exp: iat + MIS_DATOS_TTL_SECONDS };
  const body = `m1.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return { token: `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export type MisDatosVerification = { readonly ok: true; readonly claims: MisDatosClaims } | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

export function verifyMisDatosToken(key: Buffer, token: unknown, nowMs: number = Date.now()): MisDatosVerification {
  if (typeof token !== "string" || token.length > 600) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "m1" || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(`m1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: MisDatosClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as MisDatosClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims.org !== "string" || !UUID_RE.test(claims.org) || typeof claims.req !== "string" || !UUID_RE.test(claims.req) || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
