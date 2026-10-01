// D-08 -- token del enlace del portal del cliente final. El token en claro (43 caracteres base64url,
// 256 bits de entropia) solo existe en el momento de crear el enlace y en el fragmento (#) del enlace
// que se entrega al cliente: la base y los logs guardan UNICAMENTE su SHA-256. Con 256 bits de entropia
// un hash sin sal es suficiente (no hay diccionario que atacar), y permite buscar por indice exacto.
import { createHash, randomBytes } from "node:crypto";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generarTokenPortal(): string {
  return randomBytes(32).toString("base64url");
}

/** Forma valida de un token (no dice nada de si existe): descarta basura antes de tocar la base. */
export function esTokenPortalValido(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function hashTokenPortal(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
