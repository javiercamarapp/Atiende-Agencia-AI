// Fase 3 §4 paso 2/3 — el `state` que ata la redirección de OAuth de vuelta a
// `organizationId + providerId + propertyId` SIN depender de sesión de servidor
// (Google redirige el navegador directo al callback, que no lleva el JWT del
// staff). Firmado con HMAC-SHA256 sobre el MISMO secreto de plataforma que ya usa
// `whatsapp/meta-signature.ts` (`ApiEnv.whatsappAppSecret`) — nunca un secreto
// nuevo, ver diseño §4 paso 2. Vive en domain-citas (no en la ruta HTTP) para ser
// unit-testeable sin levantar Hono y para que connect/callback compartan
// exactamente la misma lógica de firma/verificación.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface GoogleCalendarOAuthState {
  readonly organizationId: string;
  readonly providerId: string;
  readonly propertyId: string;
  readonly issuedAt: number; // epoch ms
}

/** Tiempo real para que el staff complete el consentimiento en la pantalla de
 * Google antes de que el `state` expire — más corto que una sesión JWT a propósito
 * (este token solo vive el viaje de ida y vuelta a Google, nunca se reutiliza). */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("hex");
}

export function signGoogleCalendarOAuthState(state: Omit<GoogleCalendarOAuthState, "issuedAt">, secret: string, now: Date = new Date()): string {
  const payload: GoogleCalendarOAuthState = { ...state, issuedAt: now.getTime() };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/** Devuelve `null` ante CUALQUIER forma de token inválido — mal formado, firma que
 * no calza, o expirado — nunca lanza (el caller HTTP decide el 401/400, ver
 * google-calendar-oauth.ts). Comparación de firma en tiempo constante. */
export function verifyGoogleCalendarOAuthState(token: string, secret: string, now: Date = new Date()): GoogleCalendarOAuthState | null {
  const separatorIndex = token.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return null;
  const payloadB64 = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!/^[0-9a-f]+$/i.test(signature)) return null;

  const expected = sign(payloadB64, secret);
  const actualBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<GoogleCalendarOAuthState>;
    if (typeof payload.organizationId !== "string" || !payload.organizationId || typeof payload.providerId !== "string" || !payload.providerId || typeof payload.propertyId !== "string" || !payload.propertyId || typeof payload.issuedAt !== "number") {
      return null;
    }
    if (now.getTime() - payload.issuedAt > OAUTH_STATE_TTL_MS || now.getTime() < payload.issuedAt) return null;
    return { organizationId: payload.organizationId, providerId: payload.providerId, propertyId: payload.propertyId, issuedAt: payload.issuedAt };
  } catch {
    return null;
  }
}
