// Rn-01/Rn-02 -- monitor del sync iCal y de conflictos de calendario (overbooking entre
// canales / capa cruzada), para la pantalla "Monitor de sincronización" del staff:
//   GET  /rentas/:propertyId/sync-monitor                          estado por feed + alertas abiertas + conflictos abiertos
//   GET  /rentas/:propertyId/conflictos?estado=abiertos|todos      conflictos de calendario
//   POST /rentas/:propertyId/conflictos/:conflictoId/resolver      marcar un conflicto como resuelto (decisión humana)
//   POST /rentas/:propertyId/sync-alertas/:alertaId/atender        marcar una alerta de sync como atendida
// Mismo criterio de sesión/roles que ical-sync.ts: authMiddleware + dbSession +
// requirePropertyMembership, con `assertVerticalRole` fino por handler
// (SYNC_CALENDARIO_LECTURA_ROLES para leer, SYNC_CALENDARIO_ESCRITURA_ROLES para resolver).
//
// Compatibilidad con la base sin migrar (migración 024 pendiente): el estado por feed se
// lee sin las columnas de lease/backoff, la bitácora responde `disponible: false` con
// lista vacía y resolver/atender responden 409 "aún no disponible" -- nunca un 500 (ver
// los SAVEPOINT en PostgresRentasCalendarSyncRepository).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { SYNC_CALENDARIO_ESCRITURA_ROLES, SYNC_CALENDARIO_LECTURA_ROLES, clasificarSaludFeed } from "@atiende/domain-rentas";
import type { ConflictoMonitorRecord, FeedMonitorRecord } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE_CONFLICTOS = 100;
const LIMITE_ALERTAS = 50;

function requireUuid(value: string | undefined, campo: string): string {
  if (!value || !UUID_RE.test(value)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return value;
}

function feedAJson(feed: FeedMonitorRecord, ahoraMs: number) {
  return {
    id: feed.id,
    unidad_id: feed.unidadId,
    unidad_nombre: feed.unidadNombre,
    canal: feed.canalCodigo,
    activo: feed.activo,
    salud: clasificarSaludFeed(feed, ahoraMs),
    ultima_sincronizacion_exitosa_en: feed.ultimaSincronizacionExitosaEn,
    en_cuarentena_desde: feed.enCuarentenaDesde,
    motivo_cuarentena: feed.motivoCuarentena,
    intentos_fallidos_consecutivos: feed.intentosFallidosConsecutivos,
    ultimo_intento_en: feed.ultimoIntentoEn,
    proximo_intento_en: feed.proximoIntentoEn,
  };
}

function conflictoAJson(k: ConflictoMonitorRecord) {
  const ocupacion = (o: ConflictoMonitorRecord["ocupacionA"] | null) =>
    o === null ? null : { id: o.id, inicio: o.inicio, fin: o.fin, estado: o.estado, capa: o.capa, canal: o.canalCodigo };
  return {
    id: k.id,
    unidad_id: k.unidadId,
    unidad_nombre: k.unidadNombre,
    tipo: k.tipo,
    detectado_en: k.detectadoEn,
    resuelto_en: k.resueltoEn,
    ocupacion_a: ocupacion(k.ocupacionA),
    ocupacion_b: ocupacion(k.ocupacionB),
  };
}

export function rentasIcalMonitorRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const rutas = ["/rentas/:propertyId/sync-monitor", "/rentas/:propertyId/conflictos", "/rentas/:propertyId/conflictos/:conflictoId/resolver", "/rentas/:propertyId/sync-alertas/:alertaId/atender"];
  for (const ruta of rutas) app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/rentas/:propertyId/sync-monitor", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasCalendarSyncRepo(c.get("db"));
    const ahoraMs = Date.now();
    const feeds = await repo.listarFeedsMonitor(propertyId);
    const bitacora = await repo.listarBitacora(propertyId, { soloAlertasAbiertas: true, limite: LIMITE_ALERTAS });
    const conflictos = await repo.listarConflictos(propertyId, { soloAbiertos: true, limite: 1 });
    return c.json(
      {
        ahora: new Date(ahoraMs).toISOString(),
        feeds: feeds.map((f) => feedAJson(f, ahoraMs)),
        alertas: {
          // `false` = la base todavía no tiene la bitácora de sync (migración pendiente).
          disponible: bitacora.disponible,
          abiertas: bitacora.alertas.map((a) => ({
            id: a.id,
            unidad_id: a.unidadId,
            unidad_nombre: a.unidadNombre,
            canal: a.canalCodigo,
            tipo: a.tipo,
            severidad: a.severidad,
            detalle: a.detalle,
            eventos_aplicados: a.eventosAplicados,
            conflictos: a.conflictos,
            creado_en: a.creadoEn,
          })),
        },
        conflictos_abiertos: conflictos.totalAbiertos,
      },
      200,
    );
  });

  app.get("/rentas/:propertyId/conflictos", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado") ?? "abiertos";
    if (estado !== "abiertos" && estado !== "todos") throw Errors.validation('estado: se esperaba "abiertos" o "todos".');
    const listado = await deps.rentasCalendarSyncRepo(c.get("db")).listarConflictos(propertyId, { soloAbiertos: estado === "abiertos", limite: LIMITE_CONFLICTOS });
    return c.json({ conflictos: listado.conflictos.map(conflictoAJson), total_abiertos: listado.totalAbiertos }, 200);
  });

  app.post("/rentas/:propertyId/conflictos/:conflictoId/resolver", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const conflictoId = requireUuid(c.req.param("conflictoId"), "conflictoId");
    const resultado = await deps.rentasCalendarSyncRepo(c.get("db")).resolverConflicto(propertyId, conflictoId, c.get("userId"));
    if (resultado === "no_disponible") throw Errors.conflict("Resolver conflictos aún no está disponible en este ambiente (migración pendiente).");
    if (resultado === "no_encontrado") throw Errors.notFound("Conflicto no encontrado en esta property o ya resuelto.");

    // Bitácora de auditoría del staff (misma transacción de la request).
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId: c.get("organizationId") as string,
      actorUserId: c.get("userId"),
      action: "conflicto_calendario.resuelto",
      entityType: "reserva",
      entityId: conflictoId,
      campo: "resuelto_en",
      antes: null,
      despues: "conflicto de calendario marcado como resuelto",
    });
    return c.json({ id: conflictoId, resuelto: true }, 200);
  });

  app.post("/rentas/:propertyId/sync-alertas/:alertaId/atender", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const alertaId = requireUuid(c.req.param("alertaId"), "alertaId");
    const resultado = await deps.rentasCalendarSyncRepo(c.get("db")).atenderAlerta(propertyId, alertaId, c.get("userId"));
    if (resultado === "no_disponible") throw Errors.conflict("Las alertas de sincronización aún no están disponibles en este ambiente (migración pendiente).");
    if (resultado === "no_encontrado") throw Errors.notFound("Alerta no encontrada en esta property o ya atendida.");
    return c.json({ id: alertaId, atendida: true }, 200);
  });

  return app;
}
