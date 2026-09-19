// Fase 6 §2 — conectar/desconectar/consultar estado/probar conexión de Cal.com o
// CalDAV por PROVEEDOR (mismo criterio de alcance que Fase 3/Google: la conexión
// es personal, nunca por organización/property completa — ver
// google-calendar-oauth.ts, que este archivo usa como plantilla de patrón). A
// diferencia de Google, ni Cal.com (API key) ni CalDAV (usuario + contraseña de
// aplicación) usan un flujo OAuth de redirección — el profesional ya tiene esas
// credenciales en su cuenta y las pega directo en el panel, así que esto es un
// solo POST autenticado, sin callback público:
//
//   POST /v1/citas/properties/:propertyId/providers/:providerId/calcom/connect
//   POST /v1/citas/properties/:propertyId/providers/:providerId/calcom/disconnect
//   GET  /v1/citas/properties/:propertyId/providers/:providerId/calcom/status
//   POST /v1/citas/properties/:propertyId/providers/:providerId/calcom/test-connection
//   POST /v1/citas/properties/:propertyId/providers/:providerId/caldav/connect
//   POST /v1/citas/properties/:propertyId/providers/:providerId/caldav/disconnect
//   GET  /v1/citas/properties/:propertyId/providers/:providerId/caldav/status
//   POST /v1/citas/properties/:propertyId/providers/:providerId/caldav/test-connection
//
// Todas staff panel (JWT + requirePropertyMembership, SIN allowedRoles — mismo
// criterio que la conexión de Google Calendar y que cancelar desde el panel).
//
// `test-connection` hace una llamada de red REAL al proveedor (GET
// /v2/slots de Cal.com, REPORT calendar-query de CalDAV, vía
// `listAvailability` del contrato genérico, ver @atiende/domain-citas::calendar-
// sync-port.ts) contra la cuenta YA conectada -- nunca pide credenciales de
// nuevo. Éxito actualiza `sync_status='connected'`/limpia `sync_error` (la cuenta
// puede haber quedado en 'error' por un fallo de sincronización anterior);
// fallo clasifica la causa real (credencial/config inválida -> 4xx, proveedor
// caído/red -> 502) y la persiste en `sync_error`, nunca un 500 genérico.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CalComApiError, CalDavApiError, CalendarEventNotFoundError, consumeRateLimit } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CalComConnectBody {
  readonly api_key?: unknown;
  readonly event_type_id?: unknown;
  readonly base_url?: unknown;
}

interface CalDavConnectBody {
  readonly calendar_collection_url?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
}

/** Ventana corta y fija (24h desde "ahora") solo para probar que el proveedor
 * responde con credenciales reales -- el contenido de la disponibilidad
 * devuelta es irrelevante aquí, nunca se le muestra al staff. */
function testConnectionWindow(): { start: string; end: string } {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { start: now.toISOString(), end: end.toISOString() };
}

/**
 * Traduce un fallo real de `listAvailability` a un error HTTP honesto por causa
 * — nunca un 500 genérico:
 *   - 401/403 real del proveedor, o el recurso configurado (eventTypeId/
 *     colección) ya no existe -> 422 "credencial/configuración inválida" (el
 *     staff debe reconectar).
 *   - Cualquier otro 4xx del proveedor -> mismo 422 (la solicitud fue
 *     rechazada por algo que el staff controla: la configuración guardada).
 *   - 5xx del proveedor, timeout, o un fallo de red (`fetch` nunca llegó a
 *     tener respuesta) -> 502 "el proveedor no está disponible ahora".
 */
function classifyCalendarProviderError(err: unknown): ReturnType<typeof Errors.citasCalendarProviderCredencialInvalida> {
  if (err instanceof CalendarEventNotFoundError) {
    return Errors.citasCalendarProviderCredencialInvalida("El calendario/evento configurado ya no existe en el proveedor (revisa el event_type_id o la URL de colección).");
  }
  if (err instanceof CalComApiError || err instanceof CalDavApiError) {
    if (err.status >= 500) {
      return Errors.citasCalendarProviderNoDisponible(`El proveedor respondió con un error de servidor (${err.status}) — inténtalo de nuevo en unos minutos.`);
    }
    if (err.status === 401 || err.status === 403) {
      return Errors.citasCalendarProviderCredencialInvalida("El proveedor rechazó la credencial guardada (401/403) — reconecta con una API key/contraseña de aplicación válida.");
    }
    return Errors.citasCalendarProviderCredencialInvalida(`El proveedor rechazó la solicitud (${err.status}) — revisa la configuración guardada.`);
  }
  // TypeError de `fetch` (DNS/timeout/conexión rechazada) u otro fallo de red real.
  return Errors.citasCalendarProviderNoDisponible("No se pudo contactar al proveedor (red o tiempo de espera agotado) — inténtalo de nuevo en unos minutos.");
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

    const baseUrlRaw = typeof body.base_url === "string" ? body.base_url.trim() : "";
    let baseUrl: string | null = null;
    if (baseUrlRaw) {
      // Cal.com self-hosted -- MISMA validación SSRF real que la URL de colección
      // de CalDAV (nunca solo un chequeo de string), ver la nota de cabecera.
      const validacionUrl = await deps.citasCaldavUrlValidator(baseUrlRaw);
      if (!validacionUrl.permitida) throw Errors.validation(validacionUrl.motivo ?? "base_url no es una URL permitida.");
      baseUrl = baseUrlRaw;
    }

    const account = await citasRepo.connectProviderCalComAccount({ organizationId, providerId, calcomEventTypeId: eventTypeId, apiKey, baseUrl });
    return c.json({ connected: true, provider_id: account.providerId, calcom_event_type_id: account.calcomEventTypeId, calcom_base_url: account.baseUrl, sync_status: account.syncStatus });
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

  app.get("/v1/citas/properties/:propertyId/providers/:providerId/calcom/status", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const account = await citasRepo.findProviderCalComAccount(providerId);
    // Fase 6 §2 (seguimiento) — resumen de "sincronizaciones con problema" (citas
    // con rechazo PERMANENTE de validación, ver domain-citas::calendar-sync.ts):
    // se calcula SIEMPRE por proveedor (nunca por plataforma) -- ver
    // CalendarSyncIssuesSummary/loadProviderCalendarSyncIssues para el porqué. Se
    // pide incluso sin cuenta conectada de esta plataforma en particular, por si
    // el proveedor tiene citas 'invalid' de una conexión previa que desconectó.
    const syncIssues = await citasRepo.loadProviderCalendarSyncIssues(providerId);
    if (!account) return c.json({ connected: false, sync_status: "disconnected" as const, sync_error: null, calcom_event_type_id: null, calcom_base_url: null, sync_issues: { count: syncIssues.count, last_reason: syncIssues.lastReason } });
    // El api_key NUNCA se devuelve al navegador tras guardarse -- solo metadata
    // pública de la conexión (event_type_id/base_url/estado).
    return c.json({
      connected: account.syncStatus !== "disconnected",
      sync_status: account.syncStatus,
      sync_error: account.syncError,
      calcom_event_type_id: account.calcomEventTypeId,
      calcom_base_url: account.baseUrl,
      sync_issues: { count: syncIssues.count, last_reason: syncIssues.lastReason },
    });
  });

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/calcom/test-connection", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    // Hace una llamada de red real al proveedor -- limitado por actor+proveedor
    // (mismo orden de magnitud que cancel/reschedule/reassign-appointment, ver
    // appointments-lifecycle.ts) para que no sirva como ariete de peticiones
    // contra la infraestructura de Cal.com ni como sonda de reconocimiento.
    const limited = await consumeRateLimit(citasRepo, "citas-calendar-test-connection", requestActor(c.req.raw, providerId), 20, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const account = await citasRepo.findProviderCalComAccount(providerId);
    if (!account || account.syncStatus === "disconnected") throw Errors.citasCalendarProviderNoConectado("calcom");

    const apiKey = await citasRepo.resolveProviderCalComApiKey(providerId);
    if (!apiKey) throw Errors.citasCalendarProviderCredencialInvalida("No hay una API key guardada para esta cuenta -- reconecta Cal.com.");

    const port = deps.citasCalComPortFactory({ apiKey, ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}) });
    const window = testConnectionWindow();
    try {
      await port.listAvailability({ externalCalendarRef: account.calcomEventTypeId, startTime: window.start, endTime: window.end, timeZone: "UTC" });
      await citasRepo.markProviderCalComAccountSyncOk(providerId);
      return c.json({ ok: true, checked_at: new Date().toISOString() });
    } catch (err) {
      const mapped = classifyCalendarProviderError(err);
      if (mapped.status !== 502) await citasRepo.setProviderCalComAccountSyncError(providerId, mapped.message);
      throw mapped;
    }
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

  app.get("/v1/citas/properties/:propertyId/providers/:providerId/caldav/status", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const account = await citasRepo.findProviderCalDavAccount(providerId);
    const syncIssues = await citasRepo.loadProviderCalendarSyncIssues(providerId);
    if (!account) return c.json({ connected: false, sync_status: "disconnected" as const, sync_error: null, calendar_collection_url: null, username: null, sync_issues: { count: syncIssues.count, last_reason: syncIssues.lastReason } });
    // La contraseña de aplicación NUNCA se devuelve al navegador tras guardarse.
    return c.json({
      connected: account.syncStatus !== "disconnected",
      sync_status: account.syncStatus,
      sync_error: account.syncError,
      calendar_collection_url: account.calendarCollectionUrl,
      username: account.username,
      sync_issues: { count: syncIssues.count, last_reason: syncIssues.lastReason },
    });
  });

  app.post("/v1/citas/properties/:propertyId/providers/:providerId/caldav/test-connection", async (c) => {
    const organizationId = c.get("organizationId");
    const providerId = c.req.param("providerId");
    const citasRepo = deps.citasRepo(c.get("db"));

    const provider = await citasRepo.findProvider(organizationId, providerId);
    if (!provider) throw Errors.notFound("Proveedor no encontrado.");

    const limited = await consumeRateLimit(citasRepo, "citas-calendar-test-connection", requestActor(c.req.raw, providerId), 20, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const account = await citasRepo.findProviderCalDavAccount(providerId);
    if (!account || account.syncStatus === "disconnected") throw Errors.citasCalendarProviderNoConectado("caldav");

    const password = await citasRepo.resolveProviderCalDavPassword(providerId);
    if (!password) throw Errors.citasCalendarProviderCredencialInvalida("No hay una contraseña de aplicación guardada para esta cuenta -- reconecta CalDAV.");

    const port = deps.citasCalDavPortFactory({ calendarCollectionUrl: account.calendarCollectionUrl, username: account.username, password });
    const window = testConnectionWindow();
    try {
      await port.listAvailability({ externalCalendarRef: account.calendarCollectionUrl, startTime: window.start, endTime: window.end, timeZone: "UTC" });
      await citasRepo.markProviderCalDavAccountSyncOk(providerId);
      return c.json({ ok: true, checked_at: new Date().toISOString() });
    } catch (err) {
      const mapped = classifyCalendarProviderError(err);
      if (mapped.status !== 502) await citasRepo.setProviderCalDavAccountSyncError(providerId, mapped.message);
      throw mapped;
    }
  });

  return app;
}
