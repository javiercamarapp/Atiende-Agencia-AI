// H-42 -- tokens firmados de la reserva directa publica. Dos tokens con llaves derivadas distintas (un token de cotizacion nunca valida como
// token de estado y viceversa), HMAC-SHA256, expiran y quedan LIGADOS a organizacion + property. No contienen datos personales: el de
// cotizacion lleva lo que el servidor cotizo (tipo, fechas, huespedes, total) para que "confirmar" lo contraste con su propio recalculo; el de
// estado lleva solo el id del hold. Formato: `<tipo>1.<payload base64url>.<firma base64url>`; la firma cubre `<tipo>1.<payload>`.
// Misma construccion que apps/api/src/storefront-tracking-token.ts (restaurantes): la llave sale del secreto interno con una etiqueta propia,
// asi que no se agrega ninguna variable de entorno nueva.
import { createHmac, timingSafeEqual } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** El huesped tiene 15 minutos para confirmar lo cotizado (despues: se cotiza de nuevo). */
export const QUOTE_TOKEN_TTL_SECONDS = 15 * 60;
/** El enlace de estado/cancelacion sirve un año (cubre estancias reservadas con mucha anticipacion). */
export const ESTADO_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

export type ReservarTokenFailure = "malformed" | "bad_signature" | "expired";

export interface QuoteClaims {
  readonly org: string;
  readonly prop: string;
  readonly rt: string;
  readonly in: string;
  readonly out: string;
  readonly g: number;
  /** Total cotizado en centavos. */
  readonly tot: number;
  readonly iat: number;
  readonly exp: number;
}

export interface EstadoClaims {
  readonly org: string;
  readonly prop: string;
  readonly hold: string;
  readonly iat: number;
  readonly exp: number;
}

export function quoteTokenKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/hoteles/reservar-directo/cotizacion/v1").digest();
}

export function estadoTokenKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/hoteles/reservar-directo/estado/v1").digest();
}

function sign(key: Buffer, prefix: string, claims: object): string {
  const body = `${prefix}.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

function open(key: Buffer, prefix: string, token: string, nowMs: number): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: ReservarTokenFailure } {
  if (typeof token !== "string" || token.length > 900) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(`${prefix}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims !== "object" || typeof claims.iat !== "number" || typeof claims.exp !== "number") return { ok: false, reason: "malformed" };
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export function issueQuoteToken(key: Buffer, input: Omit<QuoteClaims, "iat" | "exp">, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return sign(key, "q1", { ...input, iat, exp: iat + QUOTE_TOKEN_TTL_SECONDS });
}

export type QuoteTokenVerification = { readonly ok: true; readonly claims: QuoteClaims } | { readonly ok: false; readonly reason: ReservarTokenFailure };

export function verifyQuoteToken(key: Buffer, token: string, nowMs: number = Date.now()): QuoteTokenVerification {
  const r = open(key, "q1", token, nowMs);
  if (!r.ok) return r;
  const c = r.claims;
  if (!isUuid(c.org) || !isUuid(c.prop) || !isUuid(c.rt) || typeof c.in !== "string" || !DATE_RE.test(c.in) || typeof c.out !== "string" || !DATE_RE.test(c.out)
      || !Number.isSafeInteger(c.g) || !Number.isSafeInteger(c.tot) || (c.tot as number) <= 0) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims: c as unknown as QuoteClaims };
}

export function issueEstadoToken(key: Buffer, input: Omit<EstadoClaims, "iat" | "exp">, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return sign(key, "e1", { ...input, iat, exp: iat + ESTADO_TOKEN_TTL_SECONDS });
}

export type EstadoTokenVerification = { readonly ok: true; readonly claims: EstadoClaims } | { readonly ok: false; readonly reason: ReservarTokenFailure };

export function verifyEstadoToken(key: Buffer, token: string, nowMs: number = Date.now()): EstadoTokenVerification {
  const r = open(key, "e1", token, nowMs);
  if (!r.ok) return r;
  const c = r.claims;
  if (!isUuid(c.org) || !isUuid(c.prop) || !isUuid(c.hold)) return { ok: false, reason: "malformed" };
  return { ok: true, claims: c as unknown as EstadoClaims };
}
