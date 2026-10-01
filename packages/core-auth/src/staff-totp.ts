// Segundo factor del STAFF (login/step-up del contrato de licitaciones). Vive aparte de totp.ts
// (MFA del superadmin, #209): mismos parametros RFC 6238, pero verificacion/cifrado propios
// (llave HKDF con otro `info`, sin AAD) porque los secretos ya cifrados no son intercambiables.
// TOTP (RFC 6238, HMAC-SHA1, 6 digitos, paso de 30 s) + codigos de respaldo + cifrado
// del secreto en reposo. Solo `node:crypto`: sin dependencia nueva, mismo criterio que
// `invite-token.ts` y `@atiende/db::password.ts`.
//
// Por que SHA1/6 digitos/30 s: es el perfil que entienden TODAS las apps de autenticacion
// (Google Authenticator, Authy, 1Password, Microsoft Authenticator); subir parametros
// romperia la compatibilidad sin ganancia real (el secreto de 160 bits es lo que protege).
//
// Anti-replay: `verifyTotp` devuelve el contador de paso (time-step) que coincidio, y el
// llamador (repositorio) solo acepta un paso ESTRICTAMENTE mayor al ultimo usado
// (`last_used_step`): un codigo observado por un tercero no sirve una segunda vez dentro
// de su ventana de validez.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { TOTP_DEFAULT_WINDOW, TOTP_DIGITS, TOTP_PERIOD_SECONDS, base32Decode } from "./totp.ts";

function hotpStaff(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpTimeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** Codigo TOTP vigente para `secretBase32` en `nowMs` (usado por tests y por el verify). */
export function computeTotp(secretBase32: string, nowMs: number): string {
  return hotpStaff(base32Decode(secretBase32), totpTimeStep(nowMs));
}

/**
 * Devuelve el paso (time-step) cuyo codigo coincide dentro de la ventana, o `null`.
 * Compara en tiempo constante y SIEMPRE recorre toda la ventana (sin salida temprana)
 * para no filtrar por temporizacion cual paso coincidio.
 */
export function verifyStaffTotp(secretBase32: string, code: string, nowMs: number, window: number = TOTP_DEFAULT_WINDOW): number | null {
  if (!/^\d{6}$/u.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpTimeStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotpStaff(secret, step));
    if (timingSafeEqual(expected, given) && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

/** URI `otpauth://` para el QR / alta manual en la app de autenticacion. */
export function buildOtpAuthUrl(input: { readonly issuer: string; readonly accountEmail: string; readonly secretBase32: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountEmail)}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Codigos de respaldo (un solo uso). Solo se persiste el hash; el texto plano se
// muestra UNA vez al generarlos. Alfabeto sin caracteres ambiguos (0/O, 1/I/L).
// ---------------------------------------------------------------------------

const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const BACKUP_CODE_COUNT = 8;

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let raw = "";
    for (let j = 0; j < 10; j += 1) raw += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** Normaliza lo que teclea el usuario (minusculas, espacios, guion opcional). */
export function normalizeBackupCode(input: string): string | null {
  const raw = input.replace(/[\s-]+/gu, "").toUpperCase();
  if (raw.length !== 10) return null;
  for (const ch of raw) if (!BACKUP_ALPHABET.includes(ch)) return null;
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function hashBackupCode(normalizedCode: string): string {
  return createHash("sha256").update(`atiende-backup-code-v1:${normalizedCode}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Cifrado del secreto TOTP en reposo (AES-256-GCM). La clave se deriva con HKDF del
// secreto de la aplicacion (`jwtSecret`) con un `info` propio: una filtracion de la
// tabla sola NO entrega secretos TOTP utilizables. Formato: `v1.<iv>.<tag>.<ct>` base64url.
// ---------------------------------------------------------------------------

function totpKey(appSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(appSecret), Buffer.alloc(0), "atiende-totp-secret-v1", 32));
}

export function encryptStaffTotpSecret(secretBase32: string, appSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", totpKey(appSecret), iv);
  const ct = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptStaffTotpSecret(stored: string, appSecret: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Secreto TOTP con formato desconocido.");
  const decipher = createDecipheriv("aes-256-gcm", totpKey(appSecret), Buffer.from(parts[1]!, "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
}
