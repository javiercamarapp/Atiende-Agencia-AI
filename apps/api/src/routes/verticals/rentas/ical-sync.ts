// Fase 5 -- /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/ical-sync:
// conectar/desconectar un feed iCal externo (Airbnb/Booking/VRBO/...) por unidad, y
// ver el estado de su última corrida de sincronización. El motor real (fetch ->
// parseo -> anti-eco -> aplicación transaccional) vive en
// @atiende/domain-rentas::ejecutarCicloImportacion — esta ruta solo administra la
// CONFIGURACIÓN del feed (URL, activo/inactivo); la corrida periódica real la dispara
// el cron interno (ver ./ical-sync-cron.ts), mismo patrón que
// /internal/citas/google-calendar-sync.
//
// Mismo criterio de sesión que bloqueos.ts/reservas.ts: authMiddleware + dbSession +
// requirePropertyMembership("propertyId"), con `assertVerticalRole` fino dentro de
// cada handler (SYNC_CALENDARIO_ESCRITURA_ROLES para conectar/desconectar,
// SYNC_CALENDARIO_LECTURA_ROLES, más permisivo, para ver estado).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { SYNC_CALENDARIO_ESCRITURA_ROLES, SYNC_CALENDARIO_LECTURA_ROLES } from "@atiende/domain-rentas";
import type { FeedExternoRecord } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ConectarFeedBody {
  readonly url?: unknown;
}

function requireUrlImportacion(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2048) {
    throw Errors.validation("url: se esperaba una URL de feed .ics no vacía (máx. 2048 caracteres).");
  }
  // Validación de forma únicamente (https:, o http:+simulador.local en desarrollo) --
  // la validación SSRF real de la IP resuelta ocurre en cada fetch real (ver
  // domain-rentas/src/sync/net/*), nunca aquí: el feed puede resolver a una IP
  // distinta entre el momento de conectar y el momento de sincronizar.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Errors.validation("url: no es una URL válida.");
  }
  const esSimuladorLocal = parsed.protocol === "http:" && parsed.hostname === "simulador.local";
  if (parsed.protocol !== "https:" && !esSimuladorLocal) {
    throw Errors.validation("url: solo se aceptan feeds https:// (un feed iCal de canal siempre es una URL pública, nunca requiere credenciales).");
  }
  return value;
}

export function rentasIcalSyncRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/unidades/:unidadId";
  const feedBase = `${base}/canales/:canalCodigo/ical-sync`;
  app.use(base + "/ical-sync", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(feedBase, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function resolverUnidadYCanal(c: Context<CoreAuthHonoEnv>) {
    // Casts seguros: ambas rutas que llaman a este helper (`feedBase`) declaran
    // literalmente `:propertyId/:unidadId/:canalCodigo` -- Hono solo pierde la
    // inferencia de tipo del parámetro porque este helper recibe un `Context`
    // genérico, no ligado a esa ruta concreta.
    const propertyId = c.req.param("propertyId") as string;
    const unidadId = c.req.param("unidadId") as string;
    const canalCodigo = c.req.param("canalCodigo") as string;
    const repo = deps.rentasRepo(c.get("db"));
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");
    const canal = await repo.findCanalPorCodigo(canalCodigo);
    if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no reconocido.`);
    return { propertyId, unidadId, canal, organizationId: c.get("organizationId") as string };
  }

  app.post(feedBase, async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const { propertyId, unidadId, canal, organizationId } = await resolverUnidadYCanal(c);
    const raw = await readJsonCapped<ConectarFeedBody>(c.req.raw, 4 * 1024);
    const urlImportacion = requireUrlImportacion(raw.url);

    const syncRepo = deps.rentasCalendarSyncRepo(c.get("db"));
    const resultado = await syncRepo.connectFeed({ organizationId, propertyId, unidadId, canalId: canal.id, urlImportacion });

    // r5 -- bitácora de auditoría (conexión de canal iCal). `deps.rentasRepo` sobre
    // el MISMO `db` de la request -- misma transacción compartida que la escritura de
    // negocio de arriba.
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "canal.ical_conectado",
      entityType: "canal",
      entityId: resultado.id,
      campo: "url_importacion",
      antes: null,
      despues: `canal ${canal.codigo} conectado en unidad ${unidadId}`,
    });

    return c.json({ id: resultado.id, canal: canal.codigo, conectado: true }, 201);
  });

  app.delete(feedBase, async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const { propertyId, unidadId, canal, organizationId } = await resolverUnidadYCanal(c);
    const syncRepo = deps.rentasCalendarSyncRepo(c.get("db"));
    const desconectado = await syncRepo.disconnectFeed(propertyId, unidadId, canal.id);
    if (!desconectado) throw Errors.notFound("No hay un feed conectado para esta unidad/canal.");

    // r5 -- bitácora de auditoría (desconexión de canal iCal).
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "canal.ical_desconectado",
      entityType: "canal",
      entityId: null,
      campo: "activo",
      antes: "true",
      despues: `canal ${canal.codigo} desconectado en unidad ${unidadId}`,
    });

    return c.json({ canal: canal.codigo, conectado: false }, 200);
  });

  app.get(feedBase, async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const { propertyId, unidadId, canal } = await resolverUnidadYCanal(c);
    const syncRepo = deps.rentasCalendarSyncRepo(c.get("db"));
    const feed = await syncRepo.findFeed(propertyId, unidadId, canal.id);
    if (!feed) throw Errors.notFound("No hay un feed conectado para esta unidad/canal.");
    return c.json({ feed: feedAJson(feed) }, 200);
  });

  app.get(base + "/ical-sync", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId") as string;
    const unidadId = c.req.param("unidadId") as string;
    const rentasRepo = deps.rentasRepo(c.get("db"));
    const unidad = await rentasRepo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const syncRepo = deps.rentasCalendarSyncRepo(c.get("db"));
    const feeds = await syncRepo.listFeedsForUnidad(propertyId, unidadId);
    return c.json({ feeds: feeds.map(feedAJson) }, 200);
  });

  return app;
}

function feedAJson(feed: FeedExternoRecord) {
  return {
    id: feed.id,
    canal: feed.canalCodigo,
    url_importacion: feed.urlImportacion,
    activo: feed.activo,
    ultima_sincronizacion_exitosa_en: feed.estadoSync.ultimaSincronizacionExitosaEn,
    en_cuarentena_desde: feed.estadoSync.enCuarentenaDesde,
    intentos_fallidos_consecutivos: feed.estadoSync.intentosFallidosConsecutivos,
    motivo_cuarentena: feed.estadoSync.motivoCuarentena,
    drift_ultima_reconciliacion_completa: feed.driftUltimaReconciliacionCompleta,
    ultimo_resumen: feed.ultimoResumen,
  };
}
