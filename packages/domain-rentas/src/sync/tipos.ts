// Tipos de registro del bookkeeping de sincronización de calendario por canal —
// mismo criterio que domain-rentas/types.ts: ninguna función de negocio de las rutas
// de apps/api ni de ./motor.ts toca una fila cruda de SQL directamente, solo pasan
// por `RentasCalendarSyncRepository`.
import type { EstadoFeedCanal } from "./cuarentena.ts";

export interface FeedExternoRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly canalCodigo: string;
  readonly urlImportacion: string;
  readonly activo: boolean;
  readonly estadoSync: EstadoFeedCanal;
  readonly etagImport: string | null;
  readonly ultimaModificacionHttpImport: string | null;
  readonly driftUltimaReconciliacionCompleta: number;
  /** Resumen JSON de la última corrida — solo para observabilidad de
   * `GET .../sync-status`, nunca leído por el propio motor (ver ./motor.ts). */
  readonly ultimoResumen: unknown;
}

export interface NewFeedExternoInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly urlImportacion: string;
}

export interface OcupacionActivaExportable {
  readonly id: string;
  readonly inicio: string;
  readonly fin: string;
  readonly razon: string;
}

export interface VersionPreviaAlmacenada {
  readonly sequence: number | null;
  readonly dtstamp: string;
  readonly hashContenido: string;
  readonly ocupacionId: string | null;
  readonly rango: { inicio: string; fin: string } | null;
}

export interface EntradaUpsertEventoImportado {
  readonly uid: string;
  readonly sequence: number | null;
  readonly dtstamp: string;
  readonly hashContenido: string;
  readonly ocupacionId: string | null;
  readonly ultimaAccion: "aplicar" | "descartar" | "sin_cambio" | "revisar_uid_reciclado" | "eco";
  /** `false` cuando la resolución de versión decidió "sin_cambio"/"descartar": solo
   * se actualiza `ultima_accion`/`actualizado_en`, nunca se pisa la versión
   * almacenada (mismo criterio que motor.ts::upsertEventoImportado del origen). */
  readonly sobrescribirVersion: boolean;
}

export interface BloqueoExportadoPrevio {
  readonly hashContenido: string;
  readonly sequence: number;
}

/** Una fila a upsertear en `rentas.bloqueo_exportado`, para el batch de
 * `RentasCalendarSyncRepository.upsertBloqueosExportadosBatch` (ver ese archivo) --
 * mismos campos que la firma anterior de `upsertBloqueoExportado`, agrupados en un
 * solo objeto para poder pasar un arreglo de N sin N parámetros posicionales. */
export interface EntradaUpsertBloqueoExportado {
  readonly ocupacionId: string;
  readonly uidExportado: string;
  readonly hashContenido: string;
  readonly sequence: number;
}

// ---- Rn-13 / Rn-P3-23 (migración 037): token de exportación del feed y reclamo manual ----

/** Token vigente de exportación de una (unidad, canal), tal como lo ve el staff (nunca el hash ni el valor en claro). */
export interface FeedTokenEstado {
  readonly tokenId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly canalCodigo: string;
  readonly creadoEn: string;
  /** Última vez que una OTA (o cualquiera con la URL) consultó el feed por este token; `null` si nunca. */
  readonly ultimoAccesoEn: string | null;
}

/** `disponible: false` = la base todavía no tiene la migración 037 (SQLSTATE 42883/42P01/42703). */
export type ResultadoRotarFeedToken = { readonly disponible: false } | { readonly disponible: true; readonly tokenId: string; readonly creadoEn: string };
export type ResultadoListarFeedTokens = { readonly disponible: false } | { readonly disponible: true; readonly tokens: readonly FeedTokenEstado[] };

export interface FeedTokenResuelto {
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly canalCodigo: string;
}
/** `token: null` = el hash no corresponde a ningún token vigente (desconocido o revocado). */
export type ResultadoResolverFeedToken = { readonly disponible: false } | { readonly disponible: true; readonly token: FeedTokenResuelto | null };

export interface RotarFeedTokenInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly tokenHash: string;
}

/** `leaseToken: null` = el feed ya tiene un lease vigente (otro proceso lo está sincronizando) o está inactivo. */
export type ResultadoReclamoManual = { readonly disponible: false } | { readonly disponible: true; readonly leaseToken: string | null };
