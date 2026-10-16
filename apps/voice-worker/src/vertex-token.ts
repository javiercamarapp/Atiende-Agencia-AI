// Token de acceso OAuth de una CUENTA DE SERVICIO de Google para el adaptador de Vertex AI (listo, no activado: hoy se usa la Gemini API de pago).
// Sin dependencias: firma el JWT con `node:crypto` (RS256) y lo cambia por un token en `token_uri` (flujo `jwt-bearer`, https://developers.google.com/identity/protocols/oauth2/service-account).
// El token dura ~1 h: se guarda en memoria y se renueva 60 s antes de vencer. La llave privada NUNCA se registra. NO se probo contra Google real (sin proyecto de GCP).
import { createSign } from "node:crypto";

export const ALCANCE_VERTEX = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URI_POR_OMISION = "https://oauth2.googleapis.com/token";

export class VertexTokenError extends Error {}

export interface CredencialesCuentaServicio {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

/** Lee el JSON de una cuenta de servicio (`client_email`, `private_key`, `token_uri`); lanza `VertexTokenError` con un motivo corto, nunca con el contenido. */
export function leerCredencialesCuentaServicio(json: string): CredencialesCuentaServicio {
  let crudo: unknown;
  try {
    crudo = JSON.parse(json);
  } catch {
    throw new VertexTokenError("VERTEX_SERVICE_ACCOUNT_JSON no es JSON valido.");
  }
  const o = (crudo ?? {}) as Record<string, unknown>;
  if (typeof o.client_email !== "string" || !o.client_email.includes("@")) throw new VertexTokenError("VERTEX_SERVICE_ACCOUNT_JSON: falta client_email.");
  if (typeof o.private_key !== "string" || !o.private_key.includes("PRIVATE KEY")) throw new VertexTokenError("VERTEX_SERVICE_ACCOUNT_JSON: falta private_key.");
  const tokenUri = typeof o.token_uri === "string" && /^https:\/\//.test(o.token_uri) ? o.token_uri : TOKEN_URI_POR_OMISION;
  return { clientEmail: o.client_email, privateKey: o.private_key, tokenUri };
}

const b64url = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

export function firmarAserto(c: CredencialesCuentaServicio, ahoraS: number): string {
  const cabecera = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const cuerpo = b64url(JSON.stringify({ iss: c.clientEmail, scope: ALCANCE_VERTEX, aud: c.tokenUri, iat: ahoraS, exp: ahoraS + 3600 }));
  const firma = createSign("RSA-SHA256").update(`${cabecera}.${cuerpo}`).sign(c.privateKey);
  return `${cabecera}.${cuerpo}.${b64url(firma)}`;
}

export interface OpcionesTokenVertex {
  readonly credencialesJson: string;
  readonly fetchFn?: typeof fetch;
  readonly ahora?: () => number;
}

/** Devuelve una funcion que entrega siempre un token vigente (la usa `VertexLiveOpciones.accessToken` al abrir CADA sesion). */
export function crearProveedorTokenVertex(o: OpcionesTokenVertex): () => Promise<string> {
  const creds = leerCredencialesCuentaServicio(o.credencialesJson);
  const fetchFn = o.fetchFn ?? fetch;
  const ahora = o.ahora ?? Date.now;
  let token: string | null = null;
  let venceMs = 0;
  let enVuelo: Promise<string> | null = null;
  const renovar = async (): Promise<string> => {
    const res = await fetchFn(creds.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: firmarAserto(creds, Math.floor(ahora() / 1000)) }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new VertexTokenError(`Google rechazo el token de la cuenta de servicio (http ${res.status}).`);
    const cuerpo = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof cuerpo.access_token !== "string" || cuerpo.access_token === "") throw new VertexTokenError("La respuesta de Google no trae access_token.");
    const dura = typeof cuerpo.expires_in === "number" && cuerpo.expires_in > 0 ? cuerpo.expires_in : 3600;
    token = cuerpo.access_token;
    venceMs = ahora() + dura * 1000 - 60_000;
    return token;
  };
  return async () => {
    if (token !== null && ahora() < venceMs) return token;
    enVuelo ??= renovar().finally(() => {
      enVuelo = null;
    });
    return enVuelo;
  };
}
