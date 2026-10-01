// Cifrado de la boveda de identidad: AES-256-GCM en la APLICACION. La llave vive solo en
// el entorno de la API (HOTELES_IDENTITY_KEY, 32 bytes en base64); la base nunca la ve ni
// ve el texto plano. El sobre `v<version>.<iv>.<tag>.<ciphertext>` (base64url, sin
// padding) cumple el CHECK de formato de migrations/031: iv de 12 bytes = 16 chars, tag de
// 16 bytes = 22 chars. La AAD liga el sobre a (id de la fila, property): copiar un sobre
// a otra fila o property hace fallar la autenticacion al descifrar.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { IdentityDecryptError, IdentityUnavailableError } from "./errors.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_RE = /^v([0-9]{1,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{4,})$/;

export interface IdentityCipher {
  /** Version de llave con la que se cifra (se guarda en `key_version`). */
  readonly keyVersion: number;
  encrypt(plaintext: string, aad: string): string;
  /** Lanza `IdentityUnavailableError` si el sobre es de otra version de llave y
   *  `IdentityDecryptError` si la autenticacion falla. */
  decrypt(envelope: string, aad: string): string;
}

/** `aad` canonica para una fila de boveda. */
export function identityAad(vaultId: string, propertyId: string): string {
  return `${vaultId}|${propertyId}`;
}

/** Lee la llave de entorno: base64 estricto de exactamente 32 bytes, o `null` si no esta
 *  configurada. Una llave presente pero invalida es un error de configuracion (no se
 *  degrada a "sin llave" en silencio: se avisa). */
export function parseIdentityKey(raw: string | null | undefined): Buffer | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new Error("HOTELES_IDENTITY_KEY invalida: se esperaba base64 de 32 bytes (ej. `openssl rand -base64 32`).");
  }
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) {
    throw new Error(`HOTELES_IDENTITY_KEY invalida: se esperaban 32 bytes y se obtuvieron ${key.length}.`);
  }
  return key;
}

export function createIdentityCipher(key: Buffer, keyVersion = 1): IdentityCipher {
  if (key.length !== 32) throw new Error("createIdentityCipher: la llave debe tener 32 bytes.");
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 999) throw new Error("createIdentityCipher: keyVersion fuera de rango (1..999).");
  return {
    keyVersion,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v${keyVersion}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
    },
    decrypt(envelope, aad) {
      const m = ENVELOPE_RE.exec(envelope);
      if (!m) throw new IdentityDecryptError();
      if (Number(m[1]) !== keyVersion) throw new IdentityUnavailableError("llave_version_no_disponible", "decrypt");
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(m[2]!, "base64url"), { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(m[3]!, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(m[4]!, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new IdentityDecryptError();
      }
    },
  };
}
