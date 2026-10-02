// Rn-29 -- cifrado en reposo de las instrucciones de acceso (direccion exacta, codigo, indicaciones):
// AES-256-GCM en la APLICACION, mismo sobre que la boveda de identidad de hoteles
// (packages/domain-hoteles/src/identity/cipher.ts). La llave vive solo en el entorno de la API
// (RENTAS_ACCESS_KEY, 32 bytes en base64); la base guarda unicamente el sobre
// `v<version>.<iv>.<tag>.<ciphertext>` (base64url, sin padding), que cumple el CHECK de la migracion 028.
// La AAD liga cada sobre a (unidad, property, campo): copiarlo a otra unidad, otra property u otro campo
// hace fallar la autenticacion al descifrar.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AccesoDescifradoError, AccesoNoDisponibleError } from "./errores.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_RE = /^v([0-9]{1,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]*)$/;

export type CampoAcceso = "direccion" | "codigo" | "instrucciones";

export interface AccesoCipher {
  /** Version de llave con la que se cifra (se guarda en `key_version`). */
  readonly keyVersion: number;
  encrypt(plaintext: string, aad: string): string;
  /** `AccesoNoDisponibleError` si el sobre es de otra version de llave; `AccesoDescifradoError` si la autenticacion falla. */
  decrypt(envelope: string, aad: string): string;
}

/** AAD canonica de un campo de las instrucciones de una unidad. */
export function accesoAad(unidadId: string, propertyId: string, campo: CampoAcceso): string {
  return `${unidadId}|${propertyId}|${campo}`;
}

/** Lee la llave de entorno: base64 estricto de exactamente 32 bytes, o `null` si no esta configurada.
 *  Una llave presente pero invalida lanza `AccesoNoDisponibleError("llave_invalida")` (no se degrada a
 *  "sin llave" en silencio). */
export function parseAccesoKey(raw: string | null | undefined): Buffer | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) throw new AccesoNoDisponibleError("llave_invalida");
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new AccesoNoDisponibleError("llave_invalida");
  return key;
}

export function createAccesoCipher(key: Buffer, keyVersion = 1): AccesoCipher {
  if (key.length !== 32) throw new AccesoNoDisponibleError("llave_invalida");
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 999) throw new AccesoNoDisponibleError("llave_invalida");
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
      if (!m) throw new AccesoDescifradoError();
      if (Number(m[1]) !== keyVersion) throw new AccesoNoDisponibleError("llave_version_no_disponible");
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(m[2]!, "base64url"), { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(m[3]!, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(m[4]!, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new AccesoDescifradoError();
      }
    },
  };
}

/** Cifrador segun el entorno: `null` sin llave configurada; lanza `AccesoNoDisponibleError("llave_invalida")` con una llave mal formada. */
export function resolverCipherAcceso(rawKey: string | null | undefined, keyVersion: number): AccesoCipher | null {
  const key = parseAccesoKey(rawKey);
  return key ? createAccesoCipher(key, keyVersion) : null;
}
