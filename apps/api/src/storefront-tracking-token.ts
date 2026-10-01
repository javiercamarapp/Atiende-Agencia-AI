// Token de rastreo del storefront publico de restaurantes (R-09). Firmado con HMAC-SHA256, expira y queda
// LIGADO a organizacion + pedido: quien lo tiene puede ver el ESTADO de ese pedido (sin datos personales,
// ver migracion 032) y nada mas. Sin login para el cliente y sin datos personales en la URL: el token es
// opaco y no contiene nombre, telefono ni direccion.
//
// Formato: `t1.<payload base64url>.<firma base64url>`; la firma cubre `t1.<payload>`. Misma construccion
// que voice-call-token.ts (llave derivada del secreto interno con etiqueta propia: no se agrega ninguna
// variable de entorno nueva, y un token de voz nunca valida como token de rastreo).
import { createHmac, timingSafeEqual } from "node:crypto";

export interface StorefrontTrackingClaims {
  /** organization_id */
  readonly org: string;
  /** id del pedido */
  readonly ord: string;
  /** emitido / expira (segundos desde epoch) */
  readonly iat: number;
  readonly exp: number;
}

/** El cliente puede consultar su pedido hasta 3 dias despues de hacerlo. */
export const STOREFRONT_TRACKING_TTL_SECONDS = 3 * 24 * 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function storefrontTrackingKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/restaurantes/storefront-tracking/v1").digest();
}

export function signStorefrontTrackingToken(key: Buffer, claims: StorefrontTrackingClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const body = `t1.${payload}`;
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

export function issueStorefrontTrackingToken(key: Buffer, organizationId: string, orderId: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return signStorefrontTrackingToken(key, { org: organizationId, ord: orderId, iat, exp: iat + STOREFRONT_TRACKING_TTL_SECONDS });
}

export type StorefrontTrackingVerification =
  | { readonly ok: true; readonly claims: StorefrontTrackingClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

export function verifyStorefrontTrackingToken(key: Buffer, token: string, nowMs: number = Date.now()): StorefrontTrackingVerification {
  if (typeof token !== "string" || token.length > 600) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "t1" || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(`t1.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: StorefrontTrackingClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as StorefrontTrackingClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims.org !== "string" || !UUID_RE.test(claims.org) || typeof claims.ord !== "string" || !UUID_RE.test(claims.ord) || typeof claims.iat !== "number" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
