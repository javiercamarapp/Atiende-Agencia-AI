// Rn-P3-08 -- claves derivadas del formulario publico. La base NUNCA guarda el codigo de confirmacion ni el token en claro de un intento:
//  - `claveIntento`: sha256(property + codigo normalizado). Cuenta los fallos por codigo exista o no la reserva (sin oraculo de existencia).
//  - `generarToken`: 32 bytes aleatorios en base64url (43 caracteres); la base guarda solo su sha256 y es de un solo uso.
import { createHash, randomBytes } from "node:crypto";

export function claveIntento(propertyId: string, codigoNormalizado: string): string {
  return createHash("sha256").update(`${propertyId}:${codigoNormalizado}`).digest("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generarToken(aleatorios: (n: number) => Buffer = randomBytes): { readonly token: string; readonly hash: string } {
  const token = aleatorios(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
