// Token de la encuesta post-entrega (R-41). Firmado con HMAC-SHA256, expira y queda LIGADO a organizacion + pedido: quien lo tiene puede
// calificar ESE pedido (una sola vez: la base guarda la primera respuesta) y nada mas. Opaco: no contiene nombre, telefono ni direccion.
//
// Formato: `e1.<payload base64url>.<firma base64url>`; la firma cubre `e1.<payload>`. Misma construccion que storefront-tracking-token.ts
// pero con llave y prefijo PROPIOS (derivados del secreto interno con etiqueta distinta: sin variable de entorno nueva, y un token de
// rastreo, de voz o de privacidad nunca valida como token de encuesta ni al reves).
import { createHmac, timingSafeEqual } from "node:crypto";

export interface EncuestaClaims {
  /** organization_id */
  readonly org: string;
  /** id del pedido */
  readonly ord: string;
  /** emitido / expira (segundos desde epoch) */
  readonly iat: number;
  readonly exp: number;
}

/** El cliente puede responder hasta 14 dias despues de recibir la liga. */
export const ENCUESTA_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encuestaTokenKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/restaurantes/encuesta-entrega/v1").digest();
}

export function signEncuestaToken(key: Buffer, claims: EncuestaClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const body = `e1.${payload}`;
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

export function issueEncuestaToken(key: Buffer, organizationId: string, orderId: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return signEncuestaToken(key, { org: organizationId, ord: orderId, iat, exp: iat + ENCUESTA_TOKEN_TTL_SECONDS });
}

export type EncuestaTokenVerification =
  | { readonly ok: true; readonly claims: EncuestaClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

export function verifyEncuestaToken(key: Buffer, token: string, nowMs: number = Date.now()): EncuestaTokenVerification {
  if (typeof token !== "string" || token.length > 600) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "e1" || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(`e1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: EncuestaClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as EncuestaClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims.org !== "string" || !UUID_RE.test(claims.org) || typeof claims.ord !== "string" || !UUID_RE.test(claims.ord) || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
