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

export interface ConflictoMonitorRecord {
  readonly id: string;
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
