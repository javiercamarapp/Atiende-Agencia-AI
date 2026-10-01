// TOTP (RFC 6238) + HOTP (RFC 4226) con solo `node:crypto` -- sin dependencias
// nuevas. Base de la MFA del superadmin de plataforma (ver
// packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql).
//
// Decisiones:
//   - SHA-1, 6 dígitos, 30 s: es lo que soportan TODAS las apps autenticadoras
//     (Google Authenticator, Authy, 1Password...) -- parámetros distintos se
//     ignoran en silencio en varias de ellas.
//   - La verificación devuelve el PASO (time-step) que coincidió, no un
//     booleano: el llamador lo persiste (`last_used_step`) y rechaza un paso
//     ya usado -- sin eso, un código observado sigue siendo válido hasta ~90 s.
//   - Comparación en tiempo constante (`timingSafeEqual`).
//   - El secreto se guarda CIFRADO (AES-256-GCM) con una llave derivada por
//     HKDF del material que el llamador provee -- un volcado de la tabla sin la
//     llave del servidor no revela los secretos TOTP.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Tolerancia de reloj: pasos -1, 0 y +1 (±30 s). */
export const TOTP_DEFAULT_WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/u, "").replace(/\s+/gu, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("base32: carácter inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits de entropía (el tamaño que RFC 4226 recomienda), en base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32: string, counter: number, digits: number = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpAt(secretBase32: string, nowMs: number): string {
  return hotp(secretBase32, totpStep(nowMs));
}

function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Devuelve el paso (time-step) cuyo código coincide, o `null`. Recorre SIEMPRE
 * todos los pasos de la ventana (sin cortocircuito) para no filtrar por tiempo
 * cuál paso acertó. `code` debe ser exactamente `TOTP_DIGITS` dígitos.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, window: number = TOTP_DEFAULT_WINDOW): number | null {
  if (!/^\d{6}$/u.test(code)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    if (safeEqualStrings(hotp(secretBase32, step), code) && matched === null) matched = step;
  }
  return matched;
}

export function buildOtpauthUri(params: { readonly secretBase32: string; readonly accountName: string; readonly issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ── Cifrado del secreto en reposo ─────────────────────────────────────────
const KEY_INFO = "atiende/superadmin-mfa/secret/v1";

function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length < 16) throw new Error("mfa: el material de llave debe tener al menos 16 caracteres");
  return Buffer.from(hkdfSync("sha256", Buffer.from(keyMaterial), Buffer.alloc(0), KEY_INFO, 32));
}

/** Formato: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`. `aad` (p. ej. el id del usuario) ata el
 *  cifrado a su dueño: copiar el ciphertext a la fila de otro usuario falla al descifrar. */
export function encryptTotpSecret(secretBase32: string, keyMaterial: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(keyMaterial), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptTotpSecret(payload: string, keyMaterial: string, aad: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("mfa: formato de secreto cifrado inválido");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(keyMaterial), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
