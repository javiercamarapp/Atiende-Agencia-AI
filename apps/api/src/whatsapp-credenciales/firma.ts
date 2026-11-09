// Firma X-Hub-Signature-256 contra VARIAS apps de Meta y verify token por app (credenciales por organizacion, migracion 0090).
//
// Se calcula el HMAC con CADA secreto candidato y se compara en tiempo constante, sin salir antes al encontrar el bueno: el tiempo
// de respuesta no dice cual de las apps firmo ni cuantas hay. El verify token propio de una app se guarda como SHA-256 y se compara
// igual, contra todos los hashes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface CandidatoFirma {
  readonly id: string;
  readonly appSecret: string;
}

const FIRMA_RE = /^sha256=([0-9a-fA-F]{64})$/;

/** Id del candidato cuyo secreto firmo `rawBody`, o `null` (firma ausente, mal formada o de un secreto desconocido). */
export function verificarFirmaConCandidatos(rawBody: Uint8Array, firma: string | null, candidatos: readonly CandidatoFirma[]): string | null {
  const m = firma ? FIRMA_RE.exec(firma) : null;
  if (!m) return null;
  const recibida = Buffer.from(m[1]!.toLowerCase(), "hex");
  let encontrado: string | null = null;
  for (const c of candidatos) {
    const esperada = createHmac("sha256", c.appSecret).update(rawBody).digest();
    if (timingSafeEqual(esperada, recibida) && encontrado === null) encontrado = c.id;
  }
  return encontrado;
}

export function hashVerifyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** `true` si `token` coincide con alguno de los hashes (todas las comparaciones se hacen). */
export function verifyTokenEnHashes(token: string, hashes: readonly string[]): boolean {
  if (token.length === 0) return false;
  const recibido = Buffer.from(hashVerifyToken(token), "hex");
  let ok = false;
  for (const h of hashes) {
    if (!/^[0-9a-f]{64}$/.test(h)) continue;
    if (timingSafeEqual(Buffer.from(h, "hex"), recibido)) ok = true;
  }
  return ok;
}
