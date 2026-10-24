// Rn-13 -- token opaco y rotable de la URL pública de exportación del feed iCal.
//
// Por qué: la URL por UUID (`.../unidades/:unidadId/canales/:canalCodigo/feed.ics`) no se puede
// rotar y obliga a limitar por IP, y las OTA consultan desde rangos de IP compartidos. Con un token
// por (unidad, canal) el límite se aplica por token y la URL se puede revocar.
//
// El token en claro (256 bits aleatorios, base64url, 43 caracteres) se muestra UNA sola vez al crearlo
// o rotarlo; en la base solo vive su SHA-256 (rentas.feed_export_token.token_hash). Un hash de 256 bits
// de entropía no se puede invertir ni adivinar, por eso basta SHA-256 (no hace falta un hash lento).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const LONGITUD_TOKEN = 43; // 32 bytes en base64url, sin relleno.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface TokenFeedGenerado {
  /** Valor en claro: se muestra una vez y nunca se guarda ni se registra. */
  readonly token: string;
  /** SHA-256 hexadecimal: lo único que se persiste. */
  readonly hash: string;
}

export function hashTokenFeed(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generarTokenFeed(): TokenFeedGenerado {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashTokenFeed(token) };
}

/** Forma del token (no su validez): descarta basura antes de tocar la base. */
export function tokenFeedConFormatoValido(token: string): boolean {
  return token.length === LONGITUD_TOKEN && TOKEN_RE.test(token);
}

export function hashFeedConFormatoValido(hash: string): boolean {
  return HASH_RE.test(hash);
}

/** Compara dos hashes hexadecimales en tiempo constante. Falso si alguno no es un SHA-256 hexadecimal. */
export function hashesFeedIguales(a: string, b: string): boolean {
  if (!HASH_RE.test(a) || !HASH_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Ruta pública (sin origen) del feed de un token: `/rentas/feed/<token>.ics`. */
export function rutaFeedPorToken(token: string): string {
  return `/rentas/feed/${token}.ics`;
}

/** Extrae el token de la parte `:token.ics` de la ruta; `null` si no termina en `.ics` o no tiene forma de token. */
export function extraerTokenDeSegmento(segmento: string): string | null {
  if (!segmento.endsWith(".ics")) return null;
  const token = segmento.slice(0, -".ics".length);
  return tokenFeedConFormatoValido(token) ? token : null;
}

/**
 * ETag del feed: SHA-256 del contenido SIN las líneas DTSTAMP. El exportador pone `DTSTAMP = ahora` en cada
 * evento, así que el cuerpo cambia en cada petición aunque la disponibilidad sea idéntica; sin quitarlo el
 * ETag nunca coincidiría y la OTA nunca recibiría un 304.
 */
export function etagDeFeedIcs(contenidoIcs: string): string {
  const estable = contenidoIcs
    .split("\r\n")
    .filter((linea) => !linea.startsWith("DTSTAMP:"))
    .join("\r\n");
  return `"${createHash("sha256").update(estable, "utf8").digest("hex").slice(0, 32)}"`;
}
