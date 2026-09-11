// Almacenamiento del ZIP del expediente y del acuse de presentación, en disco
// local bajo `storageDir` — port del mecanismo real de
// licitaciones/apps/api/src/lib/expediente/package-storage.ts +
// lib/storage.ts (mismo patrón: ninguna ronda del origen usa S3/objeto
// remoto tampoco). Nota de alcance de Fase 1 (§4.3 del diseño): el monorepo
// fusionado todavía no tiene un motor de almacenamiento de adjuntos
// compartido entre verticales (voice-gateway/billing no lo necesitaron
// todavía) — este módulo es autocontenido y sirve como base reutilizable
// cuando esa pieza compartida se construya, igual que hoteles avanzó con
// SQL real pese a no tener aún un pool de conexión Postgres real.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

function resolveStoragePath(storageDir: string, relativePath: string): string {
  const base = isAbsolute(storageDir) ? storageDir : join(process.cwd(), storageDir);
  return join(base, relativePath);
}

export async function writePackageZip(storageDir: string, organizationId: string, proposalId: string, zip: Uint8Array): Promise<string> {
  const relativePath = join(organizationId, "packages", `${proposalId}-${Date.now()}.zip`);
  const absolutePath = resolveStoragePath(storageDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, zip);
  return relativePath;
}

export async function readPackageZip(storageDir: string, relativePath: string): Promise<Uint8Array> {
  return readFile(resolveStoragePath(storageDir, relativePath));
}

export interface StoredFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Límite defensivo de esta fase (~22MB decodificado), mismo criterio que el origen. */
export const MAX_BASE64_LENGTH = 30_000_000;

export class InvalidFileContentError extends Error {}

export function decodeBase64Content(contentBase64: string): Buffer {
  if (contentBase64.length > MAX_BASE64_LENGTH) {
    throw new InvalidFileContentError("Archivo demasiado grande para esta fase (límite ~22MB).");
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(contentBase64, "base64");
  } catch {
    throw new InvalidFileContentError("No es base64 válido.");
  }
  if (buffer.length === 0) {
    throw new InvalidFileContentError("El archivo decodificado está vacío.");
  }
  return buffer;
}

/** Guarda un archivo (el acuse de presentación, p. ej.) por hash de contenido — subir el mismo contenido dos veces nunca duplica el archivo en disco. */
export async function storeFile(storageDir: string, organizationId: string, buffer: Buffer): Promise<StoredFile> {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const relativePath = join(organizationId, `${sha256}.bin`);
  const absolutePath = resolveStoragePath(storageDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  return { relativePath, sha256, sizeBytes: buffer.length };
}
