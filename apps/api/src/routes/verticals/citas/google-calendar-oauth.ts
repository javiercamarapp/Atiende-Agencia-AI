// Fase 3 §4 — flujo de conexión OAuth de Google Calendar, por proveedor
// (`citas.providers.id`), NUNCA por organización/property completa (ver diseño §2:
// un calendario de Google es personal por naturaleza).
//
//   GET /v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect
//     -- staff panel (JWT + requirePropertyMembership, MISMO guard que ya usa
//        appointments-lifecycle.ts para cancelar) -- genera la URL de consentimiento
//        de Google con un `state` firmado (HMAC, mismo secreto de plataforma que ya
//        usa whatsapp/meta-signature.ts) que ata la redirección de vuelta a
//        organizationId+providerId+propertyId SIN depender de sesión de servidor.
//
//   GET /v1/citas/google-calendar/oauth-callback?code=...&state=...
//     -- pública/de sistema (Google redirige el navegador aquí directo, sin el JWT
//        del staff) -- valida el state, intercambia `code` por
//        {access_token,refresh_token} y SOLO ENTONCES hace upsert de
//        provider_calendar_accounts con sync_status='connected'.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { GoogleCalendarApiError, signGoogleCalendarOAuthState, verifyGoogleCalendarOAuthState } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_CALLBACK_PATH = "/v1/citas/google-calendar/oauth-callback";

function requireGoogleOAuthConfig(deps: AppDeps) {
  if (!deps.env.googleOAuth) {
    throw Errors.serviceUnavailable("Google Calendar no está configurado en esta plataforma todavía (faltan las credenciales OAuth, ver diseño Fase 3 §4/§9).");
  }
  return deps.env.googleOAuth;
}

export function citasGoogleCalendarOAuthRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // ---- Staff panel: iniciar la conexión de UN proveedor concreto ----
  app.use(
    "/v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"), // SIN allowedRoles, mismo criterio que cancelar desde el panel (ver diseño §4 paso 1).
  );
  app.get("/v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect", async (c) => {
    const googleOAuth = requireGoogleOAuthConfig(deps);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const state = signGoogleCalendarOAuthState({ organizationId, providerId, propertyId }, deps.env.whatsappAppSecret);
    const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", googleOAuth.clientId);
    url.searchParams.set("redirect_uri", `${googleOAuth.redirectBaseUrl}${OAUTH_CALLBACK_PATH}`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
    url.searchParams.set("access_type", "offline");
    // Fuerza que Google reemita refresh_token incluso si el usuario ya autorizó
    // antes — sin esto, una reconexión después de revocar acceso nunca recibe
    // refresh_token nuevo (ver diseño §4 paso 2).
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);

    return c.json({ authorize_url: url.toString() });
  });

  // ---- Callback público: Google redirige aquí tras el consentimiento ----
  app.get(OAUTH_CALLBACK_PATH, async (c) => {
    const googleOAuth = requireGoogleOAuthConfig(deps);
    const code = c.req.query("code");
    const stateToken = c.req.query("state");
    const oauthError = c.req.query("error");
    if (oauthError) throw Errors.validation(`Google denegó la conexión: ${oauthError}`);
    if (!code || !stateToken) throw Errors.validation("Faltan code o state en la redirección de Google.");

    const state = verifyGoogleCalendarOAuthState(stateToken, deps.env.whatsappAppSecret);
    if (!state) throw Errors.unauthorized("El enlace de conexión es inválido o expiró — vuelve a iniciar la conexión desde el panel.");

    let exchanged;
    try {
      exchanged = await deps.citasGoogleTokenExchange({
        code,
        redirectUri: `${googleOAuth.redirectBaseUrl}${OAUTH_CALLBACK_PATH}`,
        clientId: googleOAuth.clientId,
        clientSecret: googleOAuth.clientSecret,
      });
    } catch (err) {
      const message = err instanceof GoogleCalendarApiError ? err.message : err instanceof Error ? err.message : "fallo desconocido";
      throw Errors.validation(`No se pudo intercambiar el código de autorización con Google: ${message}`);
    }
    if (!exchanged.refreshToken) {
      // Pasa cuando el usuario ya había autorizado antes y Google decide no
      // reemitir refresh_token pese a `prompt=consent` (caso raro, pero real) —
      // nunca se conecta la cuenta sin un refresh token real que guardar.
      throw Errors.validation("Google no devolvió un refresh_token. Revoca el acceso de atiende.ai desde tu cuenta de Google (myaccount.google.com/permissions) e inténtalo de nuevo.");
    }

    // Callback público (Google redirige el navegador aquí directo, sin JWT de
    // staff) -- sin authMiddleware/dbSession, abre su propia sesión de sistema.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const provider = await citasRepo.findProvider(state.organizationId, state.providerId);
      if (!provider) throw Errors.notFound("El proveedor de esta conexión ya no existe.");

      const account = await citasRepo.connectProviderCalendarAccount({
        organizationId: state.organizationId,
        providerId: state.providerId,
        googleCalendarId: "primary",
        refreshToken: exchanged.refreshToken!,
      });

      return c.json({ connected: true, provider_id: account.providerId, google_calendar_id: account.googleCalendarId, sync_status: account.syncStatus });
    });
  });

  return app;
}
