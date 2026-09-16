// "Sign in with Google" para staff (las 6 verticales) — Google OAuth 2.0
// Authorization Code + PKCE (RFC 7636), mismo mecanismo que atiende-hoteles ya
// prueba en producción (`apps/api/src/lib/googleOAuth.ts` + `routes/
// auth-google.ts` de ese repo) — Google es SOLO un proveedor de identidad,
// NUNCA reemplaza el JWT propio (ADR-004): tras verificar el id_token, se
// emite la MISMA sesión que `POST /auth/login` ya emite hoy (ver
// `apps/api/src/routes/auth-google.ts` de este monorepo).
//
// A diferencia de hoteles (que persiste `state`/`nonce`/`code_verifier` en una
// tabla `oauth_state` con consumo atómico de un solo uso), este archivo firma
// esos tres valores + `purpose`/`vertical` en un JWT de corta duración (10 min,
// `signOAuthState`/`verifyOAuthState` abajo) con el MISMO secreto de staff
// (`jwtSecret`) — sin tabla nueva, sin estado en el servidor, sin job de
// limpieza. Ver `supabase/migrations/..._0008_staff_google_identity.sql` para
// el trade-off completo de por qué esto es seguro (el `code` de autorización
// real sigue siendo de un solo uso del lado de Google, y el `nonce` embebido
// se compara contra el `nonce` real del id_token).
import { randomBytes, createHash } from "node:crypto";
import { SignJWT, jwtVerify, createRemoteJWKSet, errors as joseErrors } from "jose";

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE `code_verifier`: 43-128 caracteres, RFC 7636 §4.1 — 32 bytes de entropía
 *  real (`crypto.randomBytes`), nunca `Math.random()`. */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** PKCE `code_challenge` método S256 (RFC 7636 §4.2) — el único método que este
 *  cliente ofrece a Google (`plain` no se usa nunca: es el método débil). */
export function computeCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

/** `nonce` (anti-replay del id_token, OpenID Connect Core §3.1.2.1) — 32 bytes
 *  de entropía, se compara byte a byte contra el claim `nonce` real del
 *  id_token que Google devuelve en el intercambio de código. */
export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export class GoogleOAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

export interface OAuthStateClaims {
  readonly purpose: "login";
  readonly vertical: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Firma el `state` anti-CSRF (RFC 6749 §10.12) con los datos que
 *  `/auth/google/callback` necesita recuperar tras el redirect de Google —
 *  10 minutos de vida, mismo TTL que la tabla `oauth_state` de hoteles usaba. */
export async function signOAuthState(claims: OAuthStateClaims, secret: string): Promise<string> {
  return new SignJWT({ ...claims, type: "google_oauth_state" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secretKey(secret));
}

export async function verifyOAuthState(state: string, secret: string): Promise<OAuthStateClaims> {
  try {
    const { payload } = await jwtVerify(state, secretKey(secret));
    if (payload.type !== "google_oauth_state") throw new GoogleOAuthError("state_invalido", "El state no es un token de OAuth de Google.");
    return payload as unknown as OAuthStateClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new GoogleOAuthError("state_expirado", "El state de Google venció antes de completarse.");
    if (err instanceof GoogleOAuthError) throw err;
    throw new GoogleOAuthError("state_invalido", "El state de Google no es válido.");
  }
}

export interface GoogleTokenResponse {
  readonly idToken: string;
  readonly accessToken: string;
}

/** Intercambia el `code` de autorización por tokens (RFC 6749 §4.1.3 + PKCE
 *  §4.5). `tokenUrl` es inyectable para que las pruebas de integración apunten
 *  a un servidor OAuth falso local, nunca a la red real. */
export async function exchangeAuthorizationCode(opts: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  let res: Response;
  try {
    res = await fetch(opts.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: opts.redirectUri,
        code_verifier: opts.codeVerifier,
      }),
    });
  } catch (err) {
    throw new GoogleOAuthError("google_no_disponible", `No se pudo contactar al endpoint de token de Google: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleOAuthError("codigo_invalido", `Google rechazó el intercambio de código (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as { id_token?: string; access_token?: string };
  if (!json.id_token || !json.access_token) {
    throw new GoogleOAuthError("respuesta_invalida", "La respuesta de token de Google no incluyó id_token/access_token.");
  }
  return { idToken: json.id_token, accessToken: json.access_token };
}

export interface GoogleIdTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly nonce?: string;
  readonly name?: string;
  readonly exp: number;
  readonly iat: number;
}

// Un `JWKSet` remoto cachea sus claves en memoria por su propia lógica interna
// de `cacheMaxAge` — se guarda UNA instancia por `jwksUrl` (no una nueva por
// request) para que ese caché sea efectivo.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

/** Verifica firma (RS256 contra el JWKS de Google), `iss`, `aud` y `exp` (todo
 *  vía `jose`); ADEMÁS valida `nonce` (comparación exacta contra el nonce que
 *  ESTE servidor generó) y `email_verified === true` — ninguna de estas dos
 *  últimas las valida `jose` por sí solo. */
export async function verifyGoogleIdToken(
  idToken: string,
  opts: { readonly jwksUrl: string; readonly issuer: string; readonly audience: string; readonly expectedNonce: string },
): Promise<GoogleIdTokenClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, jwksFor(opts.jwksUrl), { issuer: opts.issuer, audience: opts.audience });
    payload = result.payload;
  } catch (err) {
    throw new GoogleOAuthError("id_token_invalido", `El id_token de Google no es válido: ${err instanceof Error ? err.message : String(err)}`);
  }

  const claims = payload as unknown as GoogleIdTokenClaims;

  if (!claims.nonce || claims.nonce !== opts.expectedNonce) {
    throw new GoogleOAuthError("nonce_invalido", "El nonce del id_token no coincide con el que se solicitó -- posible replay o confusión de sesión.");
  }
  if (claims.email_verified !== true) {
    throw new GoogleOAuthError("correo_no_verificado", "Google no reporta este correo como verificado.");
  }
  if (!claims.email || !claims.sub) {
    throw new GoogleOAuthError("id_token_incompleto", "El id_token de Google no incluye email/sub.");
  }

  return claims;
}

/** Construye la URL de autorización (RFC 6749 §4.1.1 + PKCE §4.3). */
export function buildAuthorizationUrl(opts: {
  readonly authBaseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL("/o/oauth2/v2/auth", opts.authBaseUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("nonce", opts.nonce);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  return url.toString();
}
