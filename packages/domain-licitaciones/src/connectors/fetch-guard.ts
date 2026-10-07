// Guardas de transporte compartidas por los conectores reales. Distinguen una
// fuente NO DISPONIBLE por causas externas (WAF, retirada, TLS inválido, red)
// de un fallo genérico, SIN ocultar nunca la causa: el mensaje conserva el
// código real (`CERT_HAS_EXPIRED`, `UND_ERR_CONNECT_TIMEOUT`, `403`...) en vez
// del opaco "fetch failed" de undici.
import { SourceUnavailableError } from "../connector-errors.ts";

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);
const UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

function causeOf(err: unknown): { code?: string; message?: string } {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  return { code: typeof cause?.code === "string" ? cause.code : undefined, message: typeof cause?.message === "string" ? cause.message : undefined };
}

/** `fetch` que traduce los fallos de transporte conocidos a `SourceUnavailableError` con la causa real; el resto se relanza intacto. */
export async function guardedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit | undefined, label: string): Promise<Response> {
  try {
    return init === undefined ? await fetchImpl(url) : await fetchImpl(url, init);
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") throw err;
    const { code, message } = causeOf(err);
    const detail = `${code ?? "sin código"}${message ? ` (${message})` : ""}`;
    if (code && TLS_CODES.has(code)) {
      throw new SourceUnavailableError("tls_invalid", `${label}: certificado TLS de la fuente inválido, ${detail}, en ${url}. No se desactiva la verificación TLS.`);
    }
    if (code && UNREACHABLE_CODES.has(code)) {
      throw new SourceUnavailableError("unreachable", `${label}: fuente no alcanzable desde este entorno, ${detail}, en ${url}.`);
    }
    throw err;
  }
}

/**
 * Clasifica una respuesta HTTP no exitosa: SOLO 401/403 (bloqueo del origen) son "fuente no disponible". Un 404/410 NO se degrada:
 * las URL de los conectores son constantes de este repo, así que un recurso movido o retirado se corrige aquí y debe seguir
 * contando como fallo real del cron. 429 y el resto los maneja cada conector.
 */
export function throwIfSourceUnavailable(status: number, label: string, url: string): void {
  if (status === 401 || status === 403) {
    throw new SourceUnavailableError("blocked", `${label} respondió ${status} en ${url} (acceso denegado/bloqueo del origen; no es corregible desde este repo).`);
  }
}
