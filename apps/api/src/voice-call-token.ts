// Token por llamada del agente de voz de restaurantes (ADR-PM-001 §8.1). Firmado con HMAC-SHA256,
// expira y queda LIGADO a organizacion + sucursal + callId + telefono del llamante. Lo emite el
// endpoint de alta de llamada (autenticado con el secreto de la sucursal) con el telefono que
// reporta la telefonia (caller ID), y las tools de voz lo presentan en `x-atiende-call-token`:
// el telefono y la sucursal de una herramienta salen del token, nunca de lo que escribe el modelo.
//
// Formato: `v1.<payload base64url>.<firma base64url>`; la firma cubre `v1.<payload>`.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VoiceCallClaims {
  /** organization_id */
  readonly org: string;
  /** property_id de la sucursal que atiende la llamada */
  readonly prop: string;
  /** identificador de la llamada en el proveedor de voz */
  readonly call: string;
  /** telefono del llamante, canonico de 10 digitos */
  readonly ph: string;
  /** `true` cuando el telefono lo DICTO el cliente (el caller ID no era confiable): sirve para pedido y callback, pero NO identifica al cliente (sin historial ni direcciones). */
  readonly decl?: boolean;
  /** emitido / expira (segundos desde epoch) */
  readonly iat: number;
  readonly exp: number;
}

export const VOICE_CALL_TOKEN_DEFAULT_TTL_SECONDS = 10 * 60;
export const VOICE_CALL_TOKEN_MAX_TTL_SECONDS = 30 * 60;
export const VOICE_CALL_TOKEN_HEADER = "x-atiende-call-token";
export const CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Llave de firma derivada del secreto interno de la plataforma (separacion de dominio por etiqueta):
 * no se introduce una variable de entorno nueva obligatoria. */
export function voiceCallTokenKey(internalSecret: string): Buffer {
  return createHmac("sha256", internalSecret).update("atiende/restaurantes/voice-call-token/v1").digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signVoiceCallToken(key: Buffer, claims: VoiceCallClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const body = `v1.${payload}`;
  const sig = b64url(createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export type VoiceCallTokenVerification =
  | { readonly ok: true; readonly claims: VoiceCallClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

export function verifyVoiceCallToken(key: Buffer, token: string, nowMs: number = Date.now()): VoiceCallTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[2], "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  let claims: VoiceCallClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as VoiceCallClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.org !== "string" ||
    typeof claims.prop !== "string" ||
    typeof claims.call !== "string" ||
    !CALL_ID_RE.test(claims.call) ||
    typeof claims.ph !== "string" ||
    !/^\d{10}$/.test(claims.ph) ||
    (claims.decl !== undefined && typeof claims.decl !== "boolean") ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
