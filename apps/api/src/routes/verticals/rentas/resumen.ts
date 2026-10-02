// Rn-26 -- Resumen operativo de rentas (reemplaza la lista de propiedades de la landing del panel):
//   GET /rentas/:propertyId/resumen
// Un solo viaje con agregados reales de las tablas existentes (sin SQL nuevo ni migración): llegadas/salidas de hoy en
// la zona horaria de la PROPERTY, ocupación del mes (mismo cálculo de Rn-03, sin doble conteo), conflictos de calendario
// abiertos, tareas de limpieza pendientes/vencidas, borradores de mensajería por aprobar y feeds iCal con problema, más la
// última corrida de los agentes que tienen una fuente real por propiedad. Nunca devuelve PII de huéspedes: solo conteos.
//
// Roles: el rol `limpieza` no ve el Resumen (403; el panel lo manda a "Mis tareas"). Cada bloque se oculta (estado
// "sin_permiso") si el rol no tiene permiso sobre la pantalla de origen: el mismo techo de roles que esa pantalla.
//
// Compatibilidad con la base sin migrar: cada bloque corre bajo SAVEPOINT (la sesión es una transacción por request). Si
// la tabla/columna no existe (42P01/42703/42883) o el rol no puede leerla (42501) el bloque responde "no_disponible" y el
// resto carga. Cualquier otro error se repropaga: no se enmascara.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  ACCESO_HUESPED_ROLES,
  CALENDARIO_LECTURA_ROLES,
  LIMPIEZA_OPERACION_ROLES,
  MENSAJERIA_ESCRITURA_ROLES,
  PostgresRentasReportesRepository,
  PostgresRentasResumenRepository,
  SYNC_CALENDARIO_LECTURA_ROLES,
  clasificarSaludFeed,
  generarReporteOcupacionIngresos,
  mesCalendarioDe,
} from "@atiende/domain-rentas";
import type { EstadoSaludFeed, RentasVerticalRole } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../../../deps.ts";

/** Roles que ven el Resumen: todo el staff salvo `limpieza` (su panel es "Mis tareas"). */
const RESUMEN_ROLES: readonly RentasVerticalRole[] = CALENDARIO_LECTURA_ROLES.filter((r) => r !== "limpieza");
/** Bloque de tareas: quien opera tareas, sin el rol `limpieza` (que no llega a esta pantalla). */
const TAREAS_ROLES: readonly RentasVerticalRole[] = LIMPIEZA_OPERACION_ROLES.filter((r) => r !== "limpieza");

type EstadoBloque = "ok" | "no_disponible" | "sin_permiso";

function esDegradable(err: unknown): boolean {
  return isMigrationPendingError(err) || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42501");
}

/** Corre una lectura bajo SAVEPOINT; `null` = no disponible en este ambiente (migración pendiente / sin lectura). */
function conRespaldo<T>(db: TenantDbSession, primary: () => Promise<T>): Promise<T | null> {
  return runWithSavepointFallback<T | null>({ session: db, primary, isRecoverable: esDegradable, fallback: async () => null });
}

const ordenGravedad: Record<EstadoSaludFeed, number> = { ok: 0, inactivo: 0, sin_sincronizar: 1, desactualizado: 1, en_backoff: 2, en_cuarentena: 3 };

export function rentasResumenRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ruta = "/rentas/:propertyId/resumen";
  app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(ruta, async (c) => {
    assertVerticalRole(c, RESUMEN_ROLES);
    const propertyId = c.req.param("propertyId");
    const db = c.get("db");
    const rol = c.get("verticalRole") as RentasVerticalRole;
    const puede = (roles: readonly RentasVerticalRole[]) => roles.includes(rol);

    const syncRepo = deps.rentasCalendarSyncRepo(db);
    const resumenRepo = deps.rentasResumenRepo ? deps.rentasResumenRepo(db) : new PostgresRentasResumenRepository(db);
    const reportesRepo = deps.rentasReportesRepo ? deps.rentasReportesRepo(db) : new PostgresRentasReportesRepository(db);

    const ahora = new Date();
    const zona = resolverZonaHorariaNegocio(await syncRepo.findZonaHorariaPropiedad(propertyId));
    const hoy = hoyFechaNegocio(zona);
    const periodo = mesCalendarioDe(hoy);

    // ---- llegadas y salidas de hoy + ocupación del mes (calendario) ----
    let llegadasSalidas: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    let ocupacionMes: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    if (puede(CALENDARIO_LECTURA_ROLES)) {
      const ls = await resumenRepo.llegadasSalidas(propertyId, hoy);
      llegadasSalidas = ls === null ? { estado: "no_disponible" } : { estado: "ok", llegadas: ls.llegadas, salidas: ls.salidas };
      const datos = await conRespaldo(db, () => reportesRepo.cargarDatosReporte(propertyId, periodo, {}));
      if (datos === null) ocupacionMes = { estado: "no_disponible" };
      else {
        const t = generarReporteOcupacionIngresos({ periodo, moneda: datos.moneda, unidades: datos.unidades, reservas: datos.reservas }).totales;
        ocupacionMes = {
          estado: "ok",
          periodo: { desde: periodo.inicio, hasta: periodo.fin },
          ocupacion_basis_points: t.ocupacionBasisPoints,
          noches_ocupadas: t.nochesOcupadas,
          noches_disponibles: t.nochesDisponibles,
          unidades: datos.unidades.length,
        };
      }
    }

    // ---- sincronización de calendario: conflictos abiertos y feeds con problema ----
    let conflictos: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    let feedsBloque: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    let feedsCrudos: Awaited<ReturnType<typeof syncRepo.listarFeedsMonitor>> | null = null;
    if (puede(SYNC_CALENDARIO_LECTURA_ROLES)) {
      const lc = await conRespaldo(db, () => syncRepo.listarConflictos(propertyId, { estado: "abiertos", limite: 1 }));
      conflictos = lc === null ? { estado: "no_disponible" } : { estado: "ok", abiertos: lc.totalAbiertos };
      feedsCrudos = await conRespaldo(db, () => syncRepo.listarFeedsMonitor(propertyId));
      if (feedsCrudos === null) feedsBloque = { estado: "no_disponible" };
      else {
        const activos = feedsCrudos.filter((f) => f.activo);
        const conProblema = activos.filter((f) => ordenGravedad[clasificarSaludFeed(f, ahora.getTime())] > 0).length;
        feedsBloque = { estado: "ok", activos: activos.length, con_problema: conProblema };
      }
    }

    // ---- tareas de limpieza ----
    let limpieza: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    let tareas: Awaited<ReturnType<typeof resumenRepo.tareas>> = null;
    if (puede(TAREAS_ROLES)) {
      tareas = await resumenRepo.tareas(propertyId, ahora.toISOString());
      limpieza = tareas === null ? { estado: "no_disponible" } : { estado: "ok", pendientes: tareas.pendientes, vencidas: tareas.vencidas };
    }

    // ---- borradores de mensajería por aprobar ----
    let aprobaciones: Record<string, unknown> = { estado: "sin_permiso" satisfies EstadoBloque };
    let borradores: Awaited<ReturnType<typeof resumenRepo.borradores>> = null;
    if (puede(MENSAJERIA_ESCRITURA_ROLES)) {
      borradores = await resumenRepo.borradores(propertyId);
      aprobaciones = borradores === null ? { estado: "no_disponible" } : { estado: "ok", pendientes: borradores.pendientes };
    }

    // ---- liberación de acceso (solo administración) ----
    const acceso = puede(ACCESO_HUESPED_ROLES) ? await resumenRepo.acceso(propertyId) : null;

    // ---- agentes: solo los que tienen una fuente real de "última corrida" por propiedad ----
    const agentes: Array<{ clave: string; nombre: string; ultima_corrida_en: string; estado: "ok" | "atencion" | "error"; detalle: string }> = [];
    if (feedsCrudos !== null) {
      const activos = feedsCrudos.filter((f) => f.activo);
      const intentos = activos.map((f) => f.ultimoIntentoEn ?? f.ultimaSincronizacionExitosaEn).filter((v): v is string => v !== null);
      if (intentos.length > 0) {
        const peor = activos.reduce((m, f) => Math.max(m, ordenGravedad[clasificarSaludFeed(f, ahora.getTime())]), 0);
        agentes.push({
          clave: "sync_ical",
          nombre: "Sincronización iCal",
          ultima_corrida_en: intentos.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)),
          estado: peor >= 3 ? "error" : peor >= 1 ? "atencion" : "ok",
          detalle: `${activos.length} ${activos.length === 1 ? "feed activo" : "feeds activos"}`,
        });
      }
    }
    if (borradores?.ultimoBorradorIaEn) {
      agentes.push({ clave: "borradores_ia", nombre: "Borradores de mensajería con IA", ultima_corrida_en: borradores.ultimoBorradorIaEn, estado: "ok", detalle: "Último borrador generado" });
    }
    if (acceso?.ultimaLiberacionEn) {
      agentes.push({ clave: "liberacion_acceso", nombre: "Liberación de acceso al huésped", ultima_corrida_en: acceso.ultimaLiberacionEn, estado: "ok", detalle: "Última liberación enviada" });
    }
    if (tareas?.ultimaTareaPorCheckoutEn) {
      agentes.push({ clave: "checkout_sweep", nombre: "Barrido de checkouts", ultima_corrida_en: tareas.ultimaTareaPorCheckoutEn, estado: "ok", detalle: "Última tarea de limpieza generada" });
    }

    return c.json(
      {
        ahora: ahora.toISOString(),
        zona_horaria: zona,
        hoy,
        llegadas_salidas: llegadasSalidas,
        ocupacion_mes: ocupacionMes,
        conflictos,
        limpieza,
        aprobaciones,
        feeds: feedsBloque,
        agentes,
      },
      200,
    );
  });

  return app;
}
