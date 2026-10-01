// Rn-01/Rn-02 -- monitor del sync iCal y de conflictos de calendario (overbooking entre
// canales / capa cruzada), para la pantalla "Monitor de sincronización" del staff:
//   GET  /rentas/:propertyId/sync-monitor                          estado por feed y por canal + alertas abiertas + conflictos abiertos
//   GET  /rentas/:propertyId/conflictos?estado=abiertos|resueltos|ignorados|todos   conflictos de calendario
//   GET  /rentas/:propertyId/conflictos/:conflictoId/historial     bitácora de decisiones de un conflicto
//   POST /rentas/:propertyId/conflictos/:conflictoId/resolver      decidir un conflicto: { accion: "resuelto"|"ignorado", motivo? }
//   POST /rentas/:propertyId/sync-alertas/:alertaId/atender        marcar una alerta de sync como atendida
// Mismo criterio de sesión/roles que ical-sync.ts: authMiddleware + dbSession +
// requirePropertyMembership, con `assertVerticalRole` fino por handler
// (SYNC_CALENDARIO_LECTURA_ROLES para leer, SYNC_CALENDARIO_ESCRITURA_ROLES para resolver).
//
// Compatibilidad con la base sin migrar (migración 024 pendiente): el estado por feed se
// lee sin las columnas de lease/backoff, la bitácora responde `disponible: false` con
// lista vacía y resolver/atender responden 409 "aún no disponible" -- nunca un 500 (ver
// los SAVEPOINT en PostgresRentasCalendarSyncRepository). Sin la migración 026 los conflictos
// se listan sin `ignorado`/motivo, "ignorado" responde 409 y el historial `disponible: false`.
//
// Resolver NUNCA cancela ni edita una reserva: "resuelto" exige que el solape ya no exista (lo
// verifica la base) e "ignorado" acepta el solape a sabiendas y exige un motivo.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  SYNC_CALENDARIO_ESCRITURA_ROLES,
  SYNC_CALENDARIO_LECTURA_ROLES,
  calcularSolape,
  clasificarSaludFeed,
  clasificarVigenciaSolape,
  formatearInstanteEnZona,
  normalizarDecisionConflicto,
  resolverZonaHoraria,
  resumirSyncPorCanal,
} from "@atiende/domain-rentas";
import type { ConflictoMonitorRecord, FeedMonitorRecord, FiltroEstadoConflictos } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITE_CONFLICTOS = 100;
const LIMITE_ALERTAS = 50;
const FILTROS_ESTADO: readonly FiltroEstadoConflictos[] = ["abiertos", "resueltos", "ignorados", "todos"];

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

function conflictoAJson(k: ConflictoMonitorRecord, ahoraMs: number, zona: string, userId: string) {
  const ocupacion = (o: ConflictoMonitorRecord["ocupacionA"] | null) =>
    o === null ? null : { id: o.id, inicio: o.inicio, fin: o.fin, estado: o.estado, capa: o.capa, canal: o.canalCodigo };
  // Noches que de verdad se cruzan (null si ya no se cruzan o hay una sola ocupación) y su
  // vigencia vista desde "hoy" en la zona de la PROPERTY (no la del servidor ni la UTC).
  const solape = k.ocupacionB === null ? null : calcularSolape({ inicio: k.ocupacionA.inicio, fin: k.ocupacionA.fin }, { inicio: k.ocupacionB.inicio, fin: k.ocupacionB.fin });
  return {
    id: k.id,
    estado: k.estado,
    motivo_resolucion: k.motivoResolucion,
    unidad_id: k.unidadId,
    unidad_nombre: k.unidadNombre,
    tipo: k.tipo,
    detectado_en: k.detectadoEn,
    detectado_en_local: formatearInstanteEnZona(k.detectadoEn, zona),
    resuelto_en: k.resueltoEn,
    resuelto_en_local: formatearInstanteEnZona(k.resueltoEn, zona),
    resuelto_por_mi: k.resueltoPor !== null && k.resueltoPor === userId,
    solape: solape === null ? null : { inicio: solape.inicio, fin: solape.fin, vigencia: clasificarVigenciaSolape(solape, ahoraMs, zona) },
    ocupacion_a: ocupacion(k.ocupacionA),
    ocupacion_b: ocupacion(k.ocupacionB),
  };
}

export function rentasIcalMonitorRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const rutas = [
    "/rentas/:propertyId/sync-monitor",
    "/rentas/:propertyId/conflictos",
    "/rentas/:propertyId/conflictos/:conflictoId/historial",
    "/rentas/:propertyId/conflictos/:conflictoId/resolver",
    "/rentas/:propertyId/sync-alertas/:alertaId/atender",
  ];
  for (const ruta of rutas) app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/rentas/:propertyId/sync-monitor", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasCalendarSyncRepo(c.get("db"));
    const ahoraMs = Date.now();
    const feeds = await repo.listarFeedsMonitor(propertyId);
    const bitacora = await repo.listarBitacora(propertyId, { soloAlertasAbiertas: true, limite: LIMITE_ALERTAS });
    const conflictos = await repo.listarConflictos(propertyId, { estado: "abiertos", limite: 1 });
    const zona = resolverZonaHoraria(await repo.findZonaHorariaPropiedad(propertyId));
    return c.json(
      {
        ahora: new Date(ahoraMs).toISOString(),
        zona_horaria: zona,
        feeds: feeds.map((f) => feedAJson(f, ahoraMs)),
        resumen_por_canal: resumirSyncPorCanal(feeds, ahoraMs).map((r) => ({
          canal: r.canal,
          total_feeds: r.totalFeeds,
          por_salud: r.porSalud,
          peor: r.peor,
          unidades_con_problema: r.unidadesConProblema,
          sincronizacion_mas_antigua_en: r.sincronizacionMasAntiguaEn,
        })),
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
    if (!(FILTROS_ESTADO as readonly string[]).includes(estado)) throw Errors.validation('estado: se esperaba "abiertos", "resueltos", "ignorados" o "todos".');
    const repo = deps.rentasCalendarSyncRepo(c.get("db"));
    const listado = await repo.listarConflictos(propertyId, { estado: estado as FiltroEstadoConflictos, limite: LIMITE_CONFLICTOS });
    const zona = resolverZonaHoraria(await repo.findZonaHorariaPropiedad(propertyId));
    const ahoraMs = Date.now();
    const userId = c.get("userId");
    return c.json({ zona_horaria: zona, conflictos: listado.conflictos.map((k) => conflictoAJson(k, ahoraMs, zona, userId)), total_abiertos: listado.totalAbiertos }, 200);
  });

  app.get("/rentas/:propertyId/conflictos/:conflictoId/historial", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const conflictoId = requireUuid(c.req.param("conflictoId"), "conflictoId");
    const repo = deps.rentasCalendarSyncRepo(c.get("db"));
    const historial = await repo.listarHistorialConflicto(propertyId, conflictoId);
    const zona = resolverZonaHoraria(await repo.findZonaHorariaPropiedad(propertyId));
    const userId = c.get("userId");
    return c.json(
      {
        disponible: historial.disponible,
        zona_horaria: zona,
        entradas: historial.entradas.map((e) => ({ id: e.id, accion: e.accion, motivo: e.motivo, creado_en: e.creadoEn, creado_en_local: formatearInstanteEnZona(e.creadoEn, zona), por_mi: e.actorUserId === userId })),
      },
      200,
    );
  });

  app.post("/rentas/:propertyId/conflictos/:conflictoId/resolver", async (c) => {
    assertVerticalRole(c, SYNC_CALENDARIO_ESCRITURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const conflictoId = requireUuid(c.req.param("conflictoId"), "conflictoId");
    // Cuerpo vacío = "resuelto" sin nota (compatible con clientes anteriores a Rn-02, que mandaban {}).
    const crudo = await c.req.text();
    let cuerpo: { accion?: unknown; motivo?: unknown } = {};
    if (crudo.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(crudo);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no es un objeto");
        cuerpo = parsed as { accion?: unknown; motivo?: unknown };
      } catch {
        throw Errors.validation("El cuerpo debe ser un objeto JSON.");
      }
    }
    const decision = normalizarDecisionConflicto(cuerpo.accion ?? "resuelto", cuerpo.motivo);
    if (!decision.ok) throw Errors.validation(decision.error);

    const resultado = await deps.rentasCalendarSyncRepo(c.get("db")).decidirConflicto(propertyId, conflictoId, c.get("userId"), { accion: decision.accion, motivo: decision.motivo });
    if (resultado === "no_disponible") {
      throw Errors.conflict(
        decision.accion === "ignorado"
          ? "Ignorar conflictos aún no está disponible en este ambiente (migración pendiente)."
          : "Resolver conflictos aún no está disponible en este ambiente (migración pendiente).",
      );
    }
    if (resultado === "no_encontrado") throw Errors.notFound("Conflicto no encontrado en esta property o ya cerrado.");
    if (resultado === "sin_permiso") throw Errors.forbidden("Tu rol no puede resolver conflictos de calendario.");
    if (resultado === "solape_vigente") {
      throw Errors.conflict("Las dos reservas siguen cruzadas: cancela una en su canal y vuelve a sincronizar, o ignora el conflicto indicando el motivo.");
    }

    // Bitácora de auditoría del staff (misma transacción de la request). El motivo (texto libre del
    // staff) vive solo en la bitácora del conflicto, no se duplica aquí.
    await deps.rentasRepo(c.get("db")).registrarAuditoria({
      organizationId: c.get("organizationId") as string,
      actorUserId: c.get("userId"),
      action: resultado === "ignorado" ? "conflicto_calendario.ignorado" : "conflicto_calendario.resuelto",
      entityType: "reserva",
      entityId: conflictoId,
      campo: "estado",
      antes: "abierto",
      despues: resultado,
    });
    return c.json({ id: conflictoId, resuelto: true, estado: resultado }, 200);
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
