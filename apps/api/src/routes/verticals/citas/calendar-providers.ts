// Fase 6 §2 — conectar/desconectar Cal.com o CalDAV por PROVEEDOR (mismo criterio
// de alcance que Fase 3/Google: la conexión es personal, nunca por organización/
// property completa — ver google-calendar-oauth.ts, que este archivo usa como
// plantilla de patrón). A diferencia de Google, ni Cal.com (API key) ni CalDAV
// (usuario + contraseña de aplicación) usan un flujo OAuth de redirección — el
// profesional ya tiene esas credenciales en su cuenta y las pega directo en el
// panel, así que esto es un solo POST autenticado, sin callback público:
//
//   POST /v1/citas/properties/:propertyId/providers/:providerId/calcom/connect
//   POST /v1/citas/properties/:propertyId/providers/:providerId/calcom/disconnect
//   POST /v1/citas/properties/:propertyId/providers/:providerId/caldav/connect
//   POST /v1/citas/properties/:propertyId/providers/:providerId/caldav/disconnect
//
// Todas staff panel (JWT + requirePropertyMembership, SIN allowedRoles — mismo
// criterio que la conexión de Google Calendar y que cancelar desde el panel).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CalComConnectBody {
  readonly api_key?: unknown;
  readonly event_type_id?: unknown;
}

interface CalDavConnectBody {
  readonly calendar_collection_url?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

export function citasCalendarProvidersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use(
    "/v1/citas/properties/:propertyId/providers/:providerId/calcom/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );
  app.use(
    "/v1/citas/properties/:propertyId/providers/:providerId/caldav/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requirePropertyMembership("propertyId"),
  );

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/calcom/connect", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const body = await readJsonCapped<CalComConnectBody>(c.req.raw, 8 * 1024);
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    const eventTypeId = typeof body.event_type_id === "string" ? body.event_type_id.trim() : typeof body.event_type_id === "number" ? String(body.event_type_id) : "";
    if (!apiKey || !eventTypeId) throw Errors.validation("api_key y event_type_id son requeridos.");

    const account = await citasRepo.connectProviderCalComAccount({ organizationId, providerId, calcomEventTypeId: eventTypeId, apiKey });
    return c.json({ connected: true, provider_id: account.providerId, calcom_event_type_id: account.calcomEventTypeId, sync_status: account.syncStatus });
  });

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/calcom/disconnect", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    await citasRepo.disconnectProviderCalComAccount(providerId);
    return c.json({ connected: false });
  });

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/caldav/connect", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const body = await readJsonCapped<CalDavConnectBody>(c.req.raw, 8 * 1024);
    const calendarCollectionUrl = typeof body.calendar_collection_url === "string" ? body.calendar_collection_url.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!calendarCollectionUrl || !username || !password) throw Errors.validation("calendar_collection_url, username y password son requeridos.");

    // Hallazgo de auditoría (ALTO, SSRF) — un `https://` al inicio del string NO
    // impide que el host apunte a infraestructura interna (localhost, metadata de
    // nube, RFC1918, o un hostname que resuelve ahí vía DNS rebinding). Se resuelve
    // el hostname de verdad y se valida la IP resultante contra la deny-list real
    // (ver @atiende/domain-citas::crearValidadorUrlCaldav / net/ssrf.ts) ANTES de
    // guardar la URL que `RealCalDavPort` usará después para peticiones reales.
    const validacionUrl = await deps.citasCaldavUrlValidator(calendarCollectionUrl);
    if (!validacionUrl.permitida) throw Errors.validation(validacionUrl.motivo ?? "calendar_collection_url no es una URL permitida.");

    const account = await citasRepo.connectProviderCalDavAccount({ organizationId, providerId, calendarCollectionUrl, username, password });
    return c.json({ connected: true, provider_id: account.providerId, calendar_collection_url: account.calendarCollectionUrl, username: account.username, sync_status: account.syncStatus });
  });

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/caldav/disconnect", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    await citasRepo.disconnectProviderCalDavAccount(providerId);
    return c.json({ connected: false });
  });

  return app;
}
