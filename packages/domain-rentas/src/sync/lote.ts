// Rn-01 -- orquestación del lote periódico de sync iCal, idempotente y seguro entre
// instancias. Reemplaza el barrido "todos los feeds activos, sin coordinación" de
// apps/api/.../ical-sync-cron.ts por:
//   1. CLAIM por lote en su propia transacción corta (rentas.claim_ical_feeds): cada feed
//      reclamado lleva un lease con token; dos instancias a la vez nunca reciben el mismo
//      feed, y si una muere el lease expira solo.
//   2. UNA transacción POR FEED para el ciclo del motor (un feed con datos raros nunca
//      revierte a los demás; mismo criterio que r4-fix-crons-transaccion-por-unidad).
//   3. Bitácora/alertas en otra transacción corta (best-effort: nunca tumba el lote).
//   4. LIBERAR el lease en otra más: tras un fallo fija el backoff por feed.
// Cada paso corre en su propia transacción a propósito: el error de un paso nunca deja
// abortada la sesión de otro (un try/catch simple sobre un SQLSTATE solo es seguro así).
//
// Compatibilidad con la base sin migrar: si `reclamarFeeds` devuelve `disponible: false`
// (migración 024 pendiente) el lote cae al camino anterior (todos los feeds activos, sin
// lease/bitácora/backoff), idéntico en resultado al cron anterior.
//
// Presupuesto de tiempo: la función serverless tiene maxDuration=30 s (vercel.json) y un fetch
// de feed puede tardar hasta 15 s. El lote deja de reclamar al agotar `presupuestoMs`; los feeds reclamados pero no
// alcanzados se devuelven con `liberarFeed(..., true)` y entran en la siguiente corrida
// (el piso de espaciamiento los retiene `intervaloMinimoSegundos`).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { CalendarSyncPort } from "./calendar-sync-port.ts";
import { eventosBitacoraDeCiclo, OPCIONES_RECLAMO_POR_DEFECTO, type FeedReclamado, type OpcionesReclamo } from "./lease.ts";
import { ejecutarCicloImportacion, type ResultadoImportarCiclo } from "./motor.ts";
import type { RentasCalendarSyncRepository } from "./repository.ts";
import type { FeedExternoRecord } from "./tipos.ts";

export interface DepsLoteSync {
  /** Abre UNA transacción de sesión de sistema (auth.uid() NULL) por llamada. */
  readonly conSesionSistema: <T>(fn: (db: TenantDbSession) => Promise<T>) => Promise<T>;
  readonly crearSyncRepo: (db: TenantDbSession) => RentasCalendarSyncRepository;
  readonly port: CalendarSyncPort;
  /** ms epoch; inyectable para pruebas. */
  readonly ahora?: () => number;
}

export interface OpcionesLoteSync extends Partial<OpcionesReclamo> {
  /** Tiempo máximo del lote antes de dejar de reclamar/procesar feeds (default 10 s). */
  readonly presupuestoMs?: number;
  /** Tope de feeds por invocación (default 50). */
  readonly maxFeeds?: number;
}

export interface ResultadoFeedLote {
  readonly feedId: string;
  readonly unidadId: string;
  readonly canal: string;
  readonly resultado: ResultadoImportarCiclo["resultado"] | "error_interno";
  readonly eventosAplicados: number;
  readonly conflictosDetectados: number;
  /** Reservas creadas por el ciclo (0 si el feed fallo). Con `organizationId`/`propertyId` alimenta los avisos in-app del cron. */
  readonly reservasNuevas: number;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly error?: string;
}

export interface ResultadoLoteSync {
  readonly modo: "lease" | "sin_lease";
  readonly feeds: readonly ResultadoFeedLote[];
  /** Feeds reclamados pero no alcanzados por el presupuesto de tiempo (devueltos al pool). */
  readonly devueltosPorPresupuesto: number;
}

// 10 s: el fetch de un feed puede tardar hasta 15 s (timeout de fetch-ics-seguro.ts), así que
// con la función en 30 s el peor caso es ~10 s de presupuesto + 15 s del último feed + DB.
const PRESUPUESTO_POR_DEFECTO_MS = 10_000;
const MAX_FEEDS_POR_DEFECTO = 50;

async function procesarFeed(deps: DepsLoteSync, feed: FeedExternoRecord): Promise<{ fila: ResultadoFeedLote; ciclo: ResultadoImportarCiclo | null }> {
  try {
    const ciclo = await deps.conSesionSistema(async (db) => {
      const syncRepo = deps.crearSyncRepo(db);
      const zonaHorariaPropiedad = await syncRepo.findZonaHorariaPropiedad(feed.propertyId);
      return ejecutarCicloImportacion({ db, syncRepo, port: deps.port, feed, zonaHorariaPropiedad });
    });
    return { fila: { feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: ciclo.resultado, eventosAplicados: ciclo.eventosAplicados, conflictosDetectados: ciclo.conflictosDetectados, reservasNuevas: ciclo.reservasNuevas, organizationId: feed.organizationId, propertyId: feed.propertyId }, ciclo };
  } catch (err) {
    // Un fallo real de base de datos procesando UN feed nunca detiene el resto del lote:
    // cada feed tiene su propia transacción, así que esto es un ROLLBACK real de solo él.
    return {
      fila: { feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: "error_interno", eventosAplicados: 0, conflictosDetectados: 0, reservasNuevas: 0, organizationId: feed.organizationId, propertyId: feed.propertyId, error: err instanceof Error ? err.message.slice(0, 500) : "error desconocido" },
      ciclo: null,
    };
  }
}

/** Best-effort: la bitácora y la liberación del lease nunca tumban el lote. */
async function intentar(etiqueta: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`ejecutarLoteSync: ${etiqueta} falló (se ignora; el lease expira solo):`, err instanceof Error ? err.message : err);
  }
}

export async function ejecutarLoteSync(deps: DepsLoteSync, opciones: OpcionesLoteSync = {}): Promise<ResultadoLoteSync> {
  const ahora = deps.ahora ?? (() => Date.now());
  const inicio = ahora();
  const presupuestoMs = opciones.presupuestoMs ?? PRESUPUESTO_POR_DEFECTO_MS;
  const maxFeeds = opciones.maxFeeds ?? MAX_FEEDS_POR_DEFECTO;
  const reclamo: OpcionesReclamo = {
    limite: opciones.limite ?? OPCIONES_RECLAMO_POR_DEFECTO.limite,
    leaseSegundos: opciones.leaseSegundos ?? OPCIONES_RECLAMO_POR_DEFECTO.leaseSegundos,
    intervaloMinimoSegundos: opciones.intervaloMinimoSegundos ?? OPCIONES_RECLAMO_POR_DEFECTO.intervaloMinimoSegundos,
  };
  const dentroDePresupuesto = () => ahora() - inicio < presupuestoMs;

  const filas: ResultadoFeedLote[] = [];
  let devueltos = 0;
  let modo: ResultadoLoteSync["modo"] = "lease";

  while (filas.length + devueltos < maxFeeds && dentroDePresupuesto()) {
    const resultado = await deps.conSesionSistema((db) => deps.crearSyncRepo(db).reclamarFeeds({ ...reclamo, limite: Math.min(reclamo.limite, maxFeeds - filas.length - devueltos) }));

    if (!resultado.disponible) {
      // Base sin la migración 024: camino anterior (todos los feeds activos, sin lease).
      modo = "sin_lease";
      const feeds = await deps.conSesionSistema((db) => deps.crearSyncRepo(db).listFeedsActivos());
      for (const feed of feeds) {
        filas.push((await procesarFeed(deps, feed)).fila);
      }
      break;
    }

    if (resultado.feeds.length === 0) break;

    for (const reclamado of resultado.feeds as readonly FeedReclamado[]) {
      if (!dentroDePresupuesto()) {
        devueltos += 1;
        await intentar("devolver feed por presupuesto", () => deps.conSesionSistema((db) => deps.crearSyncRepo(db).liberarFeed(reclamado.feed.id, reclamado.leaseToken, true)));
        continue;
      }
      const { fila, ciclo } = await procesarFeed(deps, reclamado.feed);
      filas.push(fila);

      const eventos = ciclo
        ? eventosBitacoraDeCiclo(ciclo)
        : [{ tipo: "error_interno" as const, severidad: "aviso" as const, detalle: `error interno procesando el feed: ${fila.error ?? "desconocido"}`.slice(0, 500), eventosAplicados: 0, conflictos: 0 }];
      for (const evento of eventos) {
        await intentar("registrar bitácora", () => deps.conSesionSistema((db) => deps.crearSyncRepo(db).registrarEventoBitacora(reclamado.feed.id, evento)));
      }

      const exito = ciclo !== null && ciclo.resultado !== "fallo_red" && ciclo.resultado !== "fallo_parseo";
      await intentar("liberar lease", () => deps.conSesionSistema((db) => deps.crearSyncRepo(db).liberarFeed(reclamado.feed.id, reclamado.leaseToken, exito)));
    }
  }

  return { modo, feeds: filas, devueltosPorPresupuesto: devueltos };
}

/** Resultado de "Sincronizar ahora" de UN feed (Rn-P3-23). */
export type ResultadoSincronizacionManual =
  /** La base todavía no tiene la migración 037 (o la 024): no hay lease con qué coordinar, así que no se corre. */
  | { readonly estado: "no_disponible" }
  /** Otro proceso (el cron u otra petición) tiene el lease del feed, o el feed está inactivo. */
  | { readonly estado: "ocupado" }
  | { readonly estado: "sincronizado"; readonly fila: ResultadoFeedLote };

/** Duración del lease de una sincronización manual: cubre el fetch (15 s) más el ciclo con holgura. */
export const LEASE_SINCRONIZACION_MANUAL_SEGUNDOS = 120;

/**
 * Rn-P3-23 -- corre el ciclo de UN feed a petición del staff, con el MISMO lease y la MISMA bitácora que el lote
 * periódico: si el cron (u otra petición) ya tiene el feed, responde `ocupado` sin tocarlo. Cada paso corre en su
 * propia transacción de sistema (igual que `ejecutarLoteSync`): el claim, el ciclo, la bitácora y la liberación.
 * Ignora el backoff del feed a propósito (el usuario pidió reintentar ya); el tope de una vez por minuto lo pone la ruta.
 */
export async function ejecutarSincronizacionManualDeFeed(deps: DepsLoteSync, feed: FeedExternoRecord): Promise<ResultadoSincronizacionManual> {
  const reclamo = await deps.conSesionSistema((db) => deps.crearSyncRepo(db).reclamarFeedManual(feed.id, LEASE_SINCRONIZACION_MANUAL_SEGUNDOS));
  if (!reclamo.disponible) return { estado: "no_disponible" };
  if (reclamo.leaseToken === null) return { estado: "ocupado" };
  const leaseToken = reclamo.leaseToken;

  const { fila, ciclo } = await procesarFeed(deps, feed);
  const eventos = ciclo
    ? eventosBitacoraDeCiclo(ciclo)
    : [{ tipo: "error_interno" as const, severidad: "aviso" as const, detalle: `error interno procesando el feed: ${fila.error ?? "desconocido"}`.slice(0, 500), eventosAplicados: 0, conflictos: 0 }];
  for (const evento of eventos) {
    await intentar("registrar bitácora (manual)", () => deps.conSesionSistema((db) => deps.crearSyncRepo(db).registrarEventoBitacora(feed.id, evento)));
  }
  const exito = ciclo !== null && ciclo.resultado !== "fallo_red" && ciclo.resultado !== "fallo_parseo";
  await intentar("liberar lease (manual)", () => deps.conSesionSistema((db) => deps.crearSyncRepo(db).liberarFeed(feed.id, leaseToken, exito)));
  return { estado: "sincronizado", fila };
}
