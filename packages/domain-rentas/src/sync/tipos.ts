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
