// Rn-01 -- sync iCal como lote idempotente: tipos y funciones PURAS de claim/lease por
// feed, backoff por feed fallido y clasificación de eventos de bitácora/alerta.
//
// El claim/lease real vive en Postgres (migrations/024_rentas_ical_sync_lease_backoff_
// bitacora.sql: `rentas.claim_ical_feeds`/`rentas.liberar_ical_feed`/
// `rentas.registrar_ical_sync_evento`, todas de solo-sistema); este módulo solo define
// el contrato TypeScript, el espejo del backoff (con test de paridad contra la función
// SQL en scripts/verify-rentas-ical-sync-lease/) y la regla de qué corridas merecen una
// fila de bitácora. Ver ./lote.ts para la orquestación.
import type { ResultadoImportarCiclo } from "./motor.ts";
import type { FeedExternoRecord } from "./tipos.ts";

/** Espejo de `rentas.ical_backoff_segundos` (migración 024): 15 min * 2^n con n =
 * fallos consecutivos acotado a [1, 10], tope de 6 h. 1 -> 30 min, 2 -> 60 min, 3 -> 2 h,
 * 4 -> 4 h, 5 o más -> 6 h. Sin dato (o 0) cuenta como 1: un fallo siempre espera. */
export const BACKOFF_FEED_BASE_SEGUNDOS = 900;
export const BACKOFF_FEED_MAX_SEGUNDOS = 21_600;

export function calcularBackoffFeedSegundos(fallosConsecutivos: number | null | undefined): number {
  const n = Math.min(Math.max(Math.trunc(fallosConsecutivos ?? 1) || 1, 1), 10);
  return Math.min(BACKOFF_FEED_MAX_SEGUNDOS, BACKOFF_FEED_BASE_SEGUNDOS * 2 ** n);
}

export interface OpcionesReclamo {
  /** Máximo de feeds por reclamo (el SQL lo acota a 1..50). */
  readonly limite: number;
  /** Vigencia del lease; si la instancia muere, expira sola (SQL: 30..900 s). */
  readonly leaseSegundos: number;
  /** Piso de espaciamiento entre dos intentos del mismo feed (SQL: 0..3600 s). */
  readonly intervaloMinimoSegundos: number;
}

export const OPCIONES_RECLAMO_POR_DEFECTO: OpcionesReclamo = { limite: 5, leaseSegundos: 120, intervaloMinimoSegundos: 600 };

export interface FeedReclamado {
  readonly feed: FeedExternoRecord;
  /** "Valla" (fencing): solo quien conserva este token puede liberar el lease. */
  readonly leaseToken: string;
}

/** `disponible: false` = la base todavía no tiene la migración 024 (SQLSTATE 42883/
 * 42P01/42703): el llamador cae al camino anterior (todos los feeds activos, sin lease). */
export type ResultadoReclamo = { readonly disponible: false } | { readonly disponible: true; readonly feeds: readonly FeedReclamado[] };

export type TipoEventoBitacora = "sync_con_cambios" | "sync_fallido" | "cuarentena_activada" | "cuarentena_persistente" | "vacio_inesperado" | "conflicto_detectado" | "error_interno";
export type SeveridadBitacora = "info" | "aviso" | "critica";

export interface EventoBitacora {
  readonly tipo: TipoEventoBitacora;
  readonly severidad: SeveridadBitacora;
  /** Texto corto sin URL del feed ni cuerpo del .ics (la URL puede ser un secreto de facto). */
  readonly detalle: string;
  readonly eventosAplicados: number;
  readonly conflictos: number;
}

/** Decide qué eventos de bitácora/alerta produce una corrida. Una corrida sin cambios ni
 * incidencias NO produce ninguno (a 15 min serían ~96 filas/día/feed sin valor). Un
 * conflicto entre canales (overbooking) es siempre `critica`. */
export function eventosBitacoraDeCiclo(ciclo: ResultadoImportarCiclo): EventoBitacora[] {
  const eventos: EventoBitacora[] = [];
  const esFallo = ciclo.resultado === "fallo_red" || ciclo.resultado === "fallo_parseo";
  const alerta = ciclo.alertaCuarentena;

  if (alerta) {
    const base = { eventosAplicados: 0, conflictos: 0 };
    if (alerta.tipo === "cuarentena_activada") eventos.push({ tipo: "cuarentena_activada", severidad: "critica", detalle: alerta.motivo, ...base });
    else if (alerta.tipo === "cuarentena_persistente") eventos.push({ tipo: "cuarentena_persistente", severidad: "aviso", detalle: alerta.motivo, ...base });
    else eventos.push({ tipo: "vacio_inesperado", severidad: "aviso", detalle: alerta.motivo, ...base });
  } else if (esFallo) {
    eventos.push({ tipo: "sync_fallido", severidad: "info", detalle: ciclo.resultado === "fallo_red" ? "no se pudo descargar el feed (se reintenta con espera creciente)" : "el feed no es un .ics válido (se reintenta con espera creciente)", eventosAplicados: 0, conflictos: 0 });
  }

  if (ciclo.conflictosDetectados > 0) {
    eventos.push({
      tipo: "conflicto_detectado",
      severidad: "critica",
      detalle: `${ciclo.conflictosDetectados} conflicto(s) de calendario detectado(s) en esta corrida: revisar el monitor de conflictos`,
      eventosAplicados: ciclo.eventosAplicados,
      conflictos: ciclo.conflictosDetectados,
    });
  } else if (ciclo.eventosAplicados > 0) {
    eventos.push({ tipo: "sync_con_cambios", severidad: "info", detalle: `${ciclo.eventosAplicados} evento(s) aplicado(s)`, eventosAplicados: ciclo.eventosAplicados, conflictos: 0 });
  }

  if (ciclo.eventosDescartadosPorError.length > 0) {
    eventos.push({ tipo: "sync_fallido", severidad: "aviso", detalle: `${ciclo.eventosDescartadosPorError.length} evento(s) del feed descartado(s) por error`, eventosAplicados: ciclo.eventosAplicados, conflictos: 0 });
  }
  return eventos;
}
