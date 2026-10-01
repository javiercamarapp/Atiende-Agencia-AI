// Rn-01/Rn-02 -- tipos y funciones puras del monitor de sync iCal y de conflictos de
// calendario (lecturas para la pantalla del staff; ver apps/api .../ical-monitor.ts).
import type { SeveridadBitacora, TipoEventoBitacora } from "./lease.ts";

export type EstadoSaludFeed = "ok" | "desactualizado" | "en_backoff" | "en_cuarentena" | "sin_sincronizar" | "inactivo";

/** Pasado este tiempo sin una sincronización exitosa, un feed activo se muestra como
 * "desactualizado". 60 min = 4 ciclos de la cadencia objetivo (15 min); con el cron
 * diario de hoy TODOS los feeds aparecen desactualizados, y eso es honesto: es
 * justamente la ventana de riesgo de overbooking que Rn-01 cierra. */
export const UMBRAL_FEED_DESACTUALIZADO_MS = 60 * 60_000;

export interface FeedMonitorRecord {
  readonly id: string;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly canalCodigo: string;
  readonly activo: boolean;
  readonly ultimaSincronizacionExitosaEn: string | null;
  readonly enCuarentenaDesde: string | null;
  readonly intentosFallidosConsecutivos: number;
  readonly motivoCuarentena: string | null;
  readonly ultimoIntentoEn: string | null;
  readonly proximoIntentoEn: string | null;
  readonly leaseHasta: string | null;
}

export function clasificarSaludFeed(feed: FeedMonitorRecord, ahoraMs: number, umbralMs: number = UMBRAL_FEED_DESACTUALIZADO_MS): EstadoSaludFeed {
  if (!feed.activo) return "inactivo";
  if (feed.enCuarentenaDesde) return "en_cuarentena";
  if (feed.proximoIntentoEn && Date.parse(feed.proximoIntentoEn) > ahoraMs) return "en_backoff";
  if (!feed.ultimaSincronizacionExitosaEn) return "sin_sincronizar";
  return ahoraMs - Date.parse(feed.ultimaSincronizacionExitosaEn) > umbralMs ? "desactualizado" : "ok";
}

export interface OcupacionConflictoRecord {
  readonly id: string;
  readonly inicio: string;
  readonly fin: string;
  readonly estado: string;
  readonly capa: string;
  readonly canalCodigo: string | null;
}

/** Estado de un conflicto: abierto (pendiente de decidir), resuelto (el solape ya no existe) o
 * ignorado (se acepta el solape a sabiendas, con motivo). Migración 026. */
export type EstadoConflicto = "abierto" | "resuelto" | "ignorado";

/** Filtro del listado de conflictos. */
export type FiltroEstadoConflictos = "abiertos" | "resueltos" | "ignorados" | "todos";

export interface ConflictoMonitorRecord {
  readonly id: string;
  readonly estado: EstadoConflicto;
  /** Motivo (o nota) de la decisión; `null` en abiertos, en los resueltos sin nota y contra una base sin 026. */
  readonly motivoResolucion: string | null;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly tipo: "capa_cruzada" | "overbooking_confirmado";
  readonly detectadoEn: string;
  readonly resueltoEn: string | null;
  readonly resueltoPor: string | null;
  readonly ocupacionA: OcupacionConflictoRecord;
  readonly ocupacionB: OcupacionConflictoRecord | null;
}

export interface ListadoConflictos {
  readonly conflictos: readonly ConflictoMonitorRecord[];
  /** Conflictos abiertos de toda la property (independiente del `limite` del listado). */
  readonly totalAbiertos: number;
}

export interface AlertaSyncRecord {
  readonly id: string;
  readonly unidadId: string;
  readonly unidadNombre: string | null;
  readonly canalCodigo: string;
  readonly tipo: TipoEventoBitacora;
  readonly severidad: SeveridadBitacora;
  readonly detalle: string;
  readonly eventosAplicados: number;
  readonly conflictos: number;
  readonly creadoEn: string;
  readonly atendidaEn: string | null;
}

/** `disponible: false` = la base todavía no tiene la migración 024 (vacío honesto). */
export interface ListadoBitacora {
  readonly disponible: boolean;
  readonly alertas: readonly AlertaSyncRecord[];
}

export type ResultadoMarcarResuelto = "resuelto" | "no_encontrado" | "no_disponible";

/** Resultado de decidir un conflicto (resolver / ignorar con motivo):
 * - `resuelto` | `ignorado`: la decisión quedó registrada.
 * - `no_encontrado`: no existe en esta property, es de otra organización o ya estaba cerrado.
 * - `solape_vigente`: se pidió "resuelto" pero las dos ocupaciones siguen cruzadas (usar "ignorado" con motivo).
 * - `sin_permiso`: el rol del actor no puede resolver conflictos (defensa en profundidad de la base).
 * - `no_disponible`: la base todavía no tiene la migración que soporta la decisión pedida. */
export type ResultadoDecisionConflicto = "resuelto" | "ignorado" | "no_encontrado" | "solape_vigente" | "sin_permiso" | "no_disponible";

export interface EntradaHistorialConflicto {
  readonly id: string;
  readonly accion: "resuelto" | "ignorado";
  readonly motivo: string | null;
  readonly actorUserId: string;
  readonly creadoEn: string;
}

/** `disponible: false` = la base todavía no tiene la bitácora de conflictos (migración 026). */
export interface HistorialConflicto {
  readonly disponible: boolean;
  readonly entradas: readonly EntradaHistorialConflicto[];
}
