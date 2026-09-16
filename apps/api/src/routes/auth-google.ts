// "Sign in with Google" para staff — las 6 verticales comparten esta ruta (mismo
// criterio que `routes/auth.ts`: el JWT propio es el único mecanismo de sesión real,
// Google es solo un proveedor de identidad, ADR-004). Dos rutas:
//   - GET /auth/google/iniciar   -- arma `state`/`nonce`/PKCE (firmados, ver
//     @atiende/core-auth::signOAuthState), redirige a Google.
//   - GET /auth/google/callback  -- intercambia el código, verifica el id_token,
//     vincula/resuelve la cuenta y emite el MISMO JWT propio que /auth/login (ver
//     `issueSession` importado de ./auth.ts) -- redirige de vuelta al panel.
//
// Sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_OAUTH_REDIRECT_BASE_URL`
// configuradas (`deps.env.googleOAuth === null`), AMBAS rutas responden 503
// explícito -- el botón "Continuar con Google" de cada Login.tsx se declara
// honestamente deshabilitado en ese caso, nunca se finge un flujo que no puede
// completarse (mismo criterio que el resto de integraciones opcionales de este
// monorepo: resend/stripe/llmProviders).
//
// ALCANCE de este pase: solo `purpose=login` (staff YA existente, dado de alta por
// invitación o registro con contraseña) -- iniciar sesión con Google NUNCA da de
// alta una organización nueva por sí solo (ver el comentario de la migración
// `..._0008_staff_google_identity.sql` para por qué el auto-registro vía Google
// queda fuera de esta pasada).
import { Hono } from "hono";
import {
  buildAuthorizationUrl,
  computeCodeChallenge,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateNonce,
  GoogleOAuthError,
  signOAuthState,
  verifyGoogleIdToken,
  verifyOAuthState,
} from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { issueSession } from "./auth.ts";
import type { AppDeps } from "../deps.ts";

const CALLBACK_PATH = "/auth/google/callback";

const VERTICALS = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
type Vertical = (typeof VERTICALS)[number];
function isVertical(v: unknown): v is Vertical {
  return typeof v === "string" && (VERTICALS as readonly string[]).includes(v);
}

function noConfigurado() {
  return Errors.serviceUnavailable("Google: pendiente de configurar en este entorno (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_BASE_URL).");
}

/** URL de login (con `?google_error=...`) a la que el callback redirige tras
 *  cualquier fallo -- SIEMPRE al login genérico de la vertical (nunca a un `/login`
 *  ambiguo): cada Login.tsx lee `google_error` de su propio querystring. */
function loginUrl(appBaseUrl: string, vertical: string): URL {
  return new URL(`/${vertical}/login`, appBaseUrl);
}

export function authGoogleRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // Lectura pública (sin sesión, GET simple) para que cada Login.tsx decida si
  // dibujar el botón "Continuar con Google" habilitado o honestamente
  // deshabilitado -- mismo patrón que `verificarGoogleConfigurado()` de
  // atiende-hoteles. Sin esto, un Login.tsx tendría que ADIVINAR si las
  // credenciales están configuradas, o mostrar el botón siempre habilitado y
  // dejar que el usuario descubra el 503 hasta después de hacer clic.
  app.get("/auth/google/status", (c) => c.json({ configured: deps.env.googleOAuth !== null }));

  app.get("/auth/google/iniciar", async (c) => {
    const google = deps.env.googleOAuth;
    if (!google) throw noConfigurado();

    const vertical = c.req.query("vertical");
    if (!isVertical(vertical)) throw Errors.validation("vertical inválida o ausente.");

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    const nonce = generateNonce();
    const redirectUri = `${google.redirectBaseUrl}${CALLBACK_PATH}`;

    const state = await signOAuthState({ purpose: "login", vertical, nonce, codeVerifier, redirectUri }, deps.env.jwtSecret);

    const authorizationUrl = buildAuthorizationUrl({
      authBaseUrl: deps.env.googleStaffAuth.authBaseUrl,
      clientId: google.clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge,
    });

    return c.redirect(authorizationUrl, 302);
  });

  app.get(CALLBACK_PATH, async (c) => {
    const google = deps.env.googleOAuth;
    if (!google) throw noConfigurado();

    const code = c.req.query("code");
    const state = c.req.query("state");

    // Sin `state` todavía no sabemos a qué vertical redirigir el error -- el único
    // caso honesto es un mensaje genérico sin vertical (nunca adivinar una).
    if (!code || !state) {
      const url = new URL("/", deps.env.appBaseUrl);
      url.searchParams.set("google_error", "parametros_faltantes");
      return c.redirect(url.toString(), 302);
    }

    let oauthState: Awaited<ReturnType<typeof verifyOAuthState>>;
    try {
      oauthState = await verifyOAuthState(state, deps.env.jwtSecret);
    } catch (err) {
      const code_ = err instanceof GoogleOAuthError ? err.code : "state_invalido";
      // Todavía sin vertical confiable (el `state` es justo lo que falló verificar) --
      // mismo criterio que arriba, error genérico sin vertical.
      const url = new URL("/", deps.env.appBaseUrl);
      url.searchParams.set("google_error", code_);
      return c.redirect(url.toString(), 302);
    }

    const { vertical } = oauthState;

    try {
      const { idToken } = await exchangeAuthorizationCode({
        tokenUrl: deps.env.googleStaffAuth.tokenUrl,
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        code,
        redirectUri: oauthState.redirectUri,
        codeVerifier: oauthState.codeVerifier,
      });

      const claims = await verifyGoogleIdToken(idToken, {
        jwksUrl: deps.env.googleStaffAuth.jwksUrl,
        issuer: deps.env.googleStaffAuth.issuer,
        audience: google.clientId,
        expectedNonce: oauthState.nonce,
      });

      // 1) ¿Ya existe una identidad de Google vinculada a este `sub`? -- caso más
      //    común tras el primer login exitoso.
      let staff = await deps.coreRepo.findStaffByGoogleSub(claims.sub);

      if (!staff) {
        // 2) ¿Existe ya una cuenta de staff con este correo (invitada por
        //    contraseña, o registrada antes)? -- se vincula la identidad de Google a
        //    ELLA, nunca se crea una cuenta duplicada.
        const existingByEmail = await deps.coreRepo.findStaffByEmail(claims.email.toLowerCase());
        if (!existingByEmail) {
          // REQ-LOGIN-GOOGLE: "cuenta no invitada -> rechazo" -- iniciar sesión con
          // Google NUNCA da de alta una cuenta nueva por sí solo (ver comentario de
          // cabecera del archivo).
          const url = loginUrl(deps.env.appBaseUrl, vertical);
          url.searchParams.set("google_error", "cuenta_no_invitada");
          return c.redirect(url.toString(), 302);
        }
        await deps.coreRepo.linkGoogleIdentity({ staffId: existingByEmail.id, sub: claims.sub, email: claims.email.toLowerCase() });
        staff = existingByEmail;
      }

      const session = await issueSession(deps, staff.id, staff.email);

      const url = new URL(`/${vertical}/auth/google/callback`, deps.env.appBaseUrl);
      url.searchParams.set("token", session.token);
      url.searchParams.set("refreshToken", session.refreshToken);
      return c.redirect(url.toString(), 302);
    } catch (err) {
      const code_ = err instanceof GoogleOAuthError ? err.code : "error_desconocido";
      const url = loginUrl(deps.env.appBaseUrl, vertical);
      url.searchParams.set("google_error", code_);
      return c.redirect(url.toString(), 302);
    }
  });

  return app;
}
