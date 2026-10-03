// Token efimero de preview de voz, firmado con HMAC-SHA256. Liga la sesion a
// organizacion + sucursal + sesion (+ voz y proveedor) y expira en minutos. NO es un token de
// Gemini: es la prueba propia de que ESTA API emitio la sesion, que el servicio de voz verifica
// antes de aceptarla (ver `verificarPreviewToken`).
//
// Formato: base64url(JSON del payload) + "." + base64url(HMAC-SHA256(secreto, primera parte)).
import { createHmac, timingSafeEqual } from "node:crypto";

export const PREVIEW_TOKEN_TTL_MAX_SEGUNDOS = 15 * 60;
export const PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS = 5 * 60;
const SECRETO_MIN_LONGITUD = 16;

export interface PreviewTokenPayload {
  readonly v: 1;
  readonly sid: string;
  readonly org: string;
  readonly prop: string;
  readonly vid: string;
  readonly prov: string;
  /** emitido / expira, en segundos epoch. */
  readonly iat: number;
  readonly exp: number;
}

export interface PreviewTokenEntrada {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly voiceId: string;
  readonly proveedor: string;
}

export type PreviewTokenVerificacion =
  | { readonly ok: true; readonly payload: PreviewTokenPayload }
  | { readonly ok: false; readonly razon: "formato" | "firma" | "expirado" | "ligadura" };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function firmar(secreto: string, parteUno: string): Buffer {
  return createHmac("sha256", secreto).update(parteUno).digest();
}

function exigirSecreto(secreto: string): void {
  if (typeof secreto !== "string" || secreto.length < SECRETO_MIN_LONGITUD) {
    throw new Error(`El secreto del token de preview debe tener al menos ${SECRETO_MIN_LONGITUD} caracteres.`);
  }
}

export function firmarPreviewToken(secreto: string, entrada: PreviewTokenEntrada, ahora: Date, ttlSegundos = PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS): { token: string; payload: PreviewTokenPayload } {
  exigirSecreto(secreto);
  if (!Number.isInteger(ttlSegundos) || ttlSegundos <= 0 || ttlSegundos > PREVIEW_TOKEN_TTL_MAX_SEGUNDOS) {
    throw new Error(`ttlSegundos debe ser un entero entre 1 y ${PREVIEW_TOKEN_TTL_MAX_SEGUNDOS}.`);
  }
  const iat = Math.floor(ahora.getTime() / 1000);
  const payload: PreviewTokenPayload = {
    v: 1,
    sid: entrada.sessionId,
    org: entrada.organizationId,
    prop: entrada.propertyId,
    vid: entrada.voiceId,
    prov: entrada.proveedor,
    iat,
    exp: iat + ttlSegundos,
  };
  const parteUno = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return { token: `${parteUno}.${b64url(firmar(secreto, parteUno))}`, payload };
}

/** Verifica firma y vigencia. `esperado` (opcional) exige ademas que el token este ligado a esa
 * organizacion/sucursal/sesion: un token de otra sucursal u organizacion se rechaza aunque su
 * firma sea valida. */
export function verificarPreviewToken(
  secreto: string,
  token: unknown,
  ahora: Date,
  esperado: { readonly sessionId?: string; readonly organizationId?: string; readonly propertyId?: string } = {},
): PreviewTokenVerificacion {
  exigirSecreto(secreto);
  if (typeof token !== "string" || token.length > 2048) return { ok: false, razon: "formato" };
  const partes = token.split(".");
  if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, razon: "formato" };
  const [parteUno, parteDos] = partes as [string, string];

  const firmaEsperada = firmar(secreto, parteUno);
  let firmaRecibida: Buffer;
  try {
    firmaRecibida = Buffer.from(parteDos, "base64url");
  } catch {
    return { ok: false, razon: "formato" };
  }
  if (firmaRecibida.length !== firmaEsperada.length || !timingSafeEqual(firmaRecibida, firmaEsperada)) return { ok: false, razon: "firma" };

  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parteUno, "base64url").toString("utf8")) as PreviewTokenPayload;
  } catch {
    return { ok: false, razon: "formato" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.sid !== "string" ||
    typeof payload.org !== "string" ||
    typeof payload.prop !== "string" ||
    typeof payload.vid !== "string" ||
    typeof payload.prov !== "string" ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return { ok: false, razon: "formato" };
  }
  if (Math.floor(ahora.getTime() / 1000) >= payload.exp) return { ok: false, razon: "expirado" };
  if (
    (esperado.sessionId !== undefined && esperado.sessionId !== payload.sid) ||
    (esperado.organizationId !== undefined && esperado.organizationId !== payload.org) ||
    (esperado.propertyId !== undefined && esperado.propertyId !== payload.prop)
  ) {
    return { ok: false, razon: "ligadura" };
  }
  return { ok: true, payload };
}
