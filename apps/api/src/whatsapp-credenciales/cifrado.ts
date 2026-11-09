// Cifrado en reposo de las credenciales de Meta por organizacion (migracion 0090): AES-256-GCM en la APLICACION, mismo sobre que la
// boveda de identidad de hoteles y el acceso de rentas (`v<version>.<iv>.<tag>.<ciphertext>`, base64url sin padding). La llave vive
// solo en el entorno de la API (WHATSAPP_CREDENTIALS_KEY, 32 bytes en base64); la base guarda unicamente el sobre. La AAD ata cada
// sobre a (credencial, organizacion, campo): copiarlo a otra credencial, otra organizacion u otro campo hace fallar el descifrado.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITMO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SOBRE_RE = /^v([0-9]{1,3})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/;

export type CampoCredencialMeta = "app_secret" | "access_token";

export class CredencialesMetaLlaveInvalidaError extends Error {
  constructor() {
    super("WHATSAPP_CREDENTIALS_KEY invalida: se esperan 32 bytes en base64");
    this.name = "CredencialesMetaLlaveInvalidaError";
  }
}

export class CredencialMetaDescifradoError extends Error {
  constructor(motivo: "sobre_invalido" | "version_no_disponible" | "autenticacion") {
    super(`no se pudo descifrar la credencial de Meta (${motivo})`);
    this.name = "CredencialMetaDescifradoError";
  }
}

export interface CifradorCredencialesMeta {
  readonly keyVersion: number;
  cifrar(textoClaro: string, aad: string): string;
  descifrar(sobre: string, aad: string): string;
}

export function aadCredencialMeta(credencialId: string, organizationId: string, campo: CampoCredencialMeta): string {
  return `whatsapp-meta|${credencialId}|${organizationId}|${campo}`;
}

/** Ausente o vacia -> `null` (la funcion queda apagada). Presente pero mal formada -> error explicito (nunca se degrada en silencio). */
export function parsearLlaveCredencialesMeta(raw: string | null | undefined): Buffer | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const limpio = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(limpio)) throw new CredencialesMetaLlaveInvalidaError();
  const llave = Buffer.from(limpio.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (llave.length !== 32) throw new CredencialesMetaLlaveInvalidaError();
  return llave;
}

export function crearCifradorCredencialesMeta(llave: Buffer, keyVersion = 1): CifradorCredencialesMeta {
  if (llave.length !== 32 || !Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 999) throw new CredencialesMetaLlaveInvalidaError();
  return {
    keyVersion,
    cifrar(textoClaro, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITMO, llave, iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(textoClaro, "utf8"), cipher.final()]);
      return `v${keyVersion}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
    },
    descifrar(sobre, aad) {
      const m = SOBRE_RE.exec(sobre);
      if (!m) throw new CredencialMetaDescifradoError("sobre_invalido");
      if (Number(m[1]) !== keyVersion) throw new CredencialMetaDescifradoError("version_no_disponible");
      try {
        const decipher = createDecipheriv(ALGORITMO, llave, Buffer.from(m[2]!, "base64url"), { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(m[3]!, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(m[4]!, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        throw new CredencialMetaDescifradoError("autenticacion");
      }
    },
  };
}
