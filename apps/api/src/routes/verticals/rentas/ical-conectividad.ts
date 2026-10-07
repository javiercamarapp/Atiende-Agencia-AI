// Paridad3 (Rn-13, Rn-P3-15/16/17/23) -- conectividad y canales de la sincronización iCal, rutas de STAFF:
//   GET  /rentas/:propertyId/canales/catalogo                                           catálogo honesto de canales de México
//   GET  /rentas/:propertyId/conectividad                                               matriz unidades x canales con el estado real
//   GET  /rentas/:propertyId/unidades/:unidadId/feed-tokens                             tokens de exportación vigentes de la unidad (sin valor ni hash)
//   POST /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed-token/rotar   crea/rota el token de la URL de exportación (se muestra UNA vez)
//   POST /rentas/:propertyId/unidades/:unidadId/ical-feeds/probar                       prueba una URL de import sin guardar nada
//   POST /rentas/:propertyId/unidades/:unidadId/ical-feeds/:canalCodigo/sincronizar     "Sincronizar ahora" de UN feed con el lease existente
// Mismo criterio de sesión/roles que ical-sync.ts: authMiddleware + dbSession + requirePropertyMembership, con
// `assertVerticalRole` fino por handler (SYNC_CALENDARIO_LECTURA_ROLES para leer, SYNC_CALENDARIO_ESCRITURA_ROLES
// para rotar, probar y sincronizar).
//
// Compatibilidad con la base sin migrar (migración 037 pendiente): el catálogo y la matriz funcionan sin ella (la
// exportación se declara "no disponible aún"); rotar y sincronizar responden 409 con un motivo honesto; la URL por UUID
// sigue funcionando. Nunca un 500 por una tabla o función que todavía no existe.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { emitirNotificacion } from "@atiende/db";
import {
  CATALOGO_CANALES_MX,
  IcsParseError,
  SYNC_CALENDARIO_ESCRITURA_ROLES,
  SYNC_CALENDARIO_LECTURA_ROLES,
  SsrfError,
  calcularMatrizConectividad,
  ejecutarSincronizacionManualDeFeed,
  generarTokenFeed,
  redactarUrlParaLog,
  resumirFeedIcs,
  rutaFeedPorToken,
} from "@atiende/domain-rentas";
import type { CanalCatalogo } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { feedUuidLegacyActivo } from "./ical-feed-publico.ts";
import { requireUrlImportacion } from "./ical-sync.ts";

const SINCRONIZAR_RATE_LIMIT = { max: 1, windowMs: 60_000 } as const;
const PROBAR_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const;
const ROTAR_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const;
const PROBAR_TIMEOUT_MS = 20_000;

function catalogoAJson(c: CanalCatalogo) {
  return {
    codigo: c.codigo,
    nombre: c.nombre,
    canal_atiende: c.canalAtiende,
    via_hoy: c.viaHoy,
    via_ical: c.viaIcal,
    descripcion_via: c.descripcionVia,
    capacidades: c.capacidades,
    capacidades_con_partner: c.capacidadesConPartner,
    latencia: c.latencia,
    bloqueo: c.bloqueo,
    requisitos: c.requisitos,
    url_proceso_oficial: c.urlProcesoOficial,
    nota_anti_paridad: c.notaAntiParidad,
    fuentes: c.fuentes,
  };
}

/** Canales con feed iCal conectable en Atiende (columnas de la matriz): tienen fila en `rentas.canal` y no son la reserva directa. */
const CANALES_MATRIZ = CATALOGO_CANALES_MX.filter((c) => c.canalAtiende !== null && c.canalAtiende !== "manual");

export function rentasIcalConectividadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const rutas = [
    "/rentas/:propertyId/canales/catalogo",
    "/rentas/:propertyId/conectividad",
    "/rentas/:propertyId/unidades/:unidadId/feed-tokens",
    "/rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed-token/rotar",
    "/rentas/:propertyId/unidades/:unidadId/ical-feeds/probar",
    "/rentas/:propertyId/unidades/:unidadId/ical-feeds/:canalCodigo/sincronizar",
  ];
  for (const ruta of rutas) app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function resolverUnidad(c: Context<CoreAuthHonoEnv>) {
    const propertyId = c.req.param("propertyId") as string;
    const unidadId = c.req.param("unidadId") as string;
    const unidad = await deps.rentasRepo(c.get("db")).findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");
    return { propertyId, unidadId, organizationId: c.get("organizationId") as string };
  }

  async function resolverUnidadYCanal(c: Context<CoreAuthHonoEnv>) {
    const base = await resolverUnidad(c);
    const canalCodigo = c.req.param("canalCodigo") as string;
    const canal = await deps.rentasRepo(c.get("db")).findCanalPorCodigo(canalCodigo);
    if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no reconocido.`);
    return { ...base, canal };
  }

  // ---- Rn-P3-15: catálogo de canales ----
  app.get("/rentas/:propertyId/canales/catalogo", (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    return c.json({ canales: CATALOGO_CANALES_MX.map(catalogoAJson) }, 200);
  });

  // ---- Rn-P3-16: matriz de conectividad ----
  app.get("/rentas/:propertyId/conectividad", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const syncRepo = deps.rentasCalendarSyncRepo(db);
    const ahoraMs = Date.now();

    const unidades = await deps.rentasRepo(db).listUnidades(propertyId);
    const feeds = await syncRepo.listarFeedsMonitor(propertyId);
    const tokens = await syncRepo.listarFeedTokens(propertyId);

    const celdas = calcularMatrizConectividad({
      unidades: unidades.map((u) => ({ id: u.id, nombre: u.name ?? "Unidad sin nombre" })),
      canales: CANALES_MATRIZ.map((x) => x.canalAtiende as string),
      feeds,
      tokens: tokens.disponible ? tokens.tokens : null,
      ahoraMs,
    });
    return c.json(
      {
        ahora: new Date(ahoraMs).toISOString(),
        // `false` = la base todavía no tiene los tokens de exportación (migración 037): la exportación se declara "no disponible aún".
        tokens_disponibles: tokens.disponible,
        canales: CANALES_MATRIZ.map(catalogoAJson),
        unidades: unidades.map((u) => ({
          id: u.id,
          nombre: u.name ?? "Unidad sin nombre",
          celdas: celdas
            .filter((x) => x.unidadId === u.id)
            .map((x) => ({
              canal: x.canal,
              estado: x.estado,
              import: {
                estado: x.import.estado,
                ultima_sincronizacion_exitosa_en: x.import.ultimaSincronizacionExitosaEn,
                en_cuarentena_desde: x.import.enCuarentenaDesde,
                motivo_cuarentena: x.import.motivoCuarentena,
                intentos_fallidos_consecutivos: x.import.intentosFallidosConsecutivos,
              },
              export: { estado: x.export.estado, token_creado_en: x.export.tokenCreadoEn, ultimo_acceso_en: x.export.ultimoAccesoEn },
            })),
        })),
      },
      200,
    );
  });

  // ---- Rn-13: tokens de exportación ----
  app.get("/rentas/:propertyId/unidades/:unidadId/feed-tokens", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const { propertyId, unidadId } = await resolverUnidad(c);
    const tokens = await deps.rentasCalendarSyncRepo(c.get("db")).listarFeedTokens(propertyId, unidadId);
    return c.json(
      {
        disponible: tokens.disponible,
        // Mientras sea true, la URL por UUID sigue respondiendo (con aviso de deprecación).
        url_uuid_activa: feedUuidLegacyActivo(),
        tokens: tokens.disponible ? tokens.tokens.map((t) => ({ canal: t.canalCodigo, creado_en: t.creadoEn, ultimo_acceso_en: t.ultimoAccesoEn })) : [],
      },
      200,
    );
  });

  app.post("/rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed-token/rotar", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const { propertyId, unidadId, organizationId, canal } = await resolverUnidadYCanal(c);
    const userId = c.get("userId") as string;
    if (!(await rateLimit(`rentas:feed-token-rotar:${userId}`, ROTAR_RATE_LIMIT.max, ROTAR_RATE_LIMIT.windowMs, { category: "rentas:feed-token-rotar" }))) {
      throw Errors.tooManyRequests("Demasiadas rotaciones seguidas. Espera un minuto.");
    }

    const { token, hash } = generarTokenFeed();
    const syncRepo = deps.rentasCalendarSyncRepo(c.get("db"));
    let resultado;
    try {
      resultado = await syncRepo.rotarFeedToken({ organizationId, propertyId, unidadId, canalId: canal.id, tokenHash: hash });
    } catch (err) {
      // La base re-valida acceso y rol (defensa en profundidad): 42501 = tu rol/tu property no permite rotar.
      if ((err as { code?: string }).code === "42501") throw Errors.forbidden();
      throw err;
    }
    if (!resultado.disponible) {
      throw Errors.conflict("La URL con token aún no está disponible en este entorno (falta aplicar una actualización de la base de datos). La URL actual sigue funcionando.");
    }

    // Bitácora: sin el token (nunca se registra el valor en claro ni el hash).
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: userId,
      action: "canal.ical_token_rotado",
      entityType: "canal",
      entityId: resultado.tokenId,
      campo: "feed_export_token",
      antes: null,
      despues: `URL de exportación de ${canal.codigo} rotada en unidad ${unidadId}`,
    });

    // El valor en claro solo existe en esta respuesta: no se cachea en ningún intermediario.
    c.header("Cache-Control", "no-store");
    return c.json({ canal: canal.codigo, token, ruta: rutaFeedPorToken(token), creado_en: resultado.creadoEn, url_uuid_activa: feedUuidLegacyActivo() }, 201);
  });

  // ---- Rn-P3-17: probar una URL sin guardar nada ----
  app.post("/rentas/:propertyId/unidades/:unidadId/ical-feeds/probar", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    await resolverUnidad(c);
    const userId = c.get("userId") as string;
    if (!(await rateLimit(`rentas:ical-probar:${userId}`, PROBAR_RATE_LIMIT.max, PROBAR_RATE_LIMIT.windowMs, { category: "rentas:ical-probar" }))) {
      throw Errors.tooManyRequests("Demasiadas pruebas seguidas. Espera un minuto.");
    }
    const raw = await readJsonCapped<{ url?: unknown }>(c.req.raw, 4 * 1024);
    const url = requireUrlImportacion(raw.url);

    // Mismo fetcher SSRF-safe que el sync real (esquema, DNS validado, IP fijada, redirecciones revalidadas, 5 MiB, timeout).
    // NO escribe nada: ni feed, ni bookkeeping, ni bitácora.
    let respuesta;
    try {
      respuesta = await Promise.race([
        deps.rentasIcalFeedPort.fetchFeed({ url, etag: null, ultimaModificacionHttp: null }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBAR_TIMEOUT_MS).unref?.()),
      ]);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw Errors.validation(`url: la dirección no está permitida (${err.motivo}). Solo se aceptan feeds públicos por https.`);
      }
      return c.json({ ok: false, tipo: "red", mensaje: "No se pudo descargar la URL (sin respuesta, DNS o tiempo agotado).", url: redactarUrlParaLog(url) }, 200);
    }

    if (respuesta.status < 200 || respuesta.status >= 300 || respuesta.cuerpo === null) {
      return c.json({ ok: false, tipo: "http", status_http: respuesta.status, mensaje: `El canal respondió con el estado HTTP ${respuesta.status}.`, url: redactarUrlParaLog(url) }, 200);
    }
    try {
      const resumen = resumirFeedIcs(respuesta.cuerpo);
      return c.json({ ok: true, status_http: respuesta.status, eventos: resumen.eventos, cancelados: resumen.cancelados, desde: resumen.desde, hasta: resumen.hasta, errores: [] }, 200);
    } catch (err) {
      if (err instanceof IcsParseError) {
        return c.json({ ok: false, tipo: "parseo", status_http: respuesta.status, mensaje: "La URL respondió, pero el contenido no es un calendario .ics válido.", errores: [{ codigo: err.codigo, mensaje: err.message }] }, 200);
      }
      throw err;
    }
  });

  // ---- Rn-P3-23: Sincronizar ahora ----
  app.post("/rentas/:propertyId/unidades/:unidadId/ical-feeds/:canalCodigo/sincronizar", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const { propertyId, unidadId, organizationId, canal } = await resolverUnidadYCanal(c);
    const feed = await deps.rentasCalendarSyncRepo(c.get("db")).findFeed(propertyId, unidadId, canal.id);
    if (!feed || !feed.activo) throw Errors.notFound("No hay un feed conectado para esta unidad/canal.");

    if (!(await rateLimit(`rentas:ical-sync-ahora:${feed.id}`, SINCRONIZAR_RATE_LIMIT.max, SINCRONIZAR_RATE_LIMIT.windowMs, { category: "rentas:ical-sync-ahora" }))) {
      throw Errors.tooManyRequests("Este feed ya se sincronizó hace menos de un minuto. Espera un momento.");
    }

    const resultado = await ejecutarSincronizacionManualDeFeed(
      {
        conSesionSistema: (fn) => deps.engine.withAppSession({ userId: null }, fn),
        crearSyncRepo: (db) => deps.rentasCalendarSyncRepo(db),
        port: deps.rentasIcalFeedPort,
      },
      feed,
    );
    if (resultado.estado === "no_disponible") {
      throw Errors.conflict("Sincronizar ahora aún no está disponible en este entorno (falta aplicar una actualización de la base de datos). El calendario se sigue sincronizando automáticamente.");
    }
    if (resultado.estado === "ocupado") throw Errors.conflict("Este feed ya se está sincronizando. Vuelve a intentar en unos segundos.");

    const fila = resultado.fila;
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId") as string,
      action: "canal.ical_sincronizado_manual",
      entityType: "canal",
      entityId: feed.id,
      campo: "sincronizacion",
      antes: null,
      despues: `canal ${canal.codigo} sincronizado a mano en unidad ${unidadId}: ${fila.resultado}`,
    });

    // Avisos in-app solo de lo que el cron no vería con su propia clave por-dia (reservas nuevas y conflictos): clave propia del
    // feed y del dia para no ocultar el aviso del cron. Best-effort: nunca cambia la respuesta.
    const dia = new Date().toISOString().slice(0, 10);
    const avisos = [
      ...(fila.reservasNuevas > 0 ? [{ evento: "rentas.reserva.nueva_ical", cantidad: fila.reservasNuevas }] : []),
      ...(fila.conflictosDetectados > 0 ? [{ evento: "rentas.conflicto.detectado", cantidad: fila.conflictosDetectados }] : []),
    ];
    for (const aviso of avisos) {
      try {
        await deps.engine.withAppSession({ userId: null }, (sesion) =>
          emitirNotificacion(sesion, { evento: aviso.evento, organizationId: fila.organizationId, propertyId: fila.propertyId, clave: `${fila.propertyId}:${dia}:manual:${feed.id}`, parametros: { cantidad: aviso.cantidad } }),
        );
      } catch {
        // best-effort
      }
    }

    const fallo = fila.resultado === "fallo_red" || fila.resultado === "fallo_parseo" || fila.resultado === "error_interno";
    return c.json(
      {
        canal: canal.codigo,
        ok: !fallo,
        resultado: fila.resultado,
        eventos_aplicados: fila.eventosAplicados,
        reservas_nuevas: fila.reservasNuevas,
        conflictos_detectados: fila.conflictosDetectados,
        ...(fallo ? { mensaje: "No se pudo sincronizar el feed; se reintentará con espera creciente." } : {}),
      },
      200,
    );
  });

  return app;
}
