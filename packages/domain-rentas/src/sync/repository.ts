// Puerto de acceso a datos del bookkeeping de sincronización de calendario por canal
// — mismo patrón dual de adaptador que RentasRepository/RentasOwnerPortalRepository:
// un puerto TS explícito, con un adaptador real en memoria (tests determinísticos) y
// un adaptador real de Postgres. Separado de `RentasRepository` a propósito (mismo
// criterio que `RentasOwnerPortalRepository` frente a `RentasRepository`): un actor
// distinto (el motor de sync, no un staff autenticado por request), tablas nuevas
// (`rentas.canal_feed_externo`/`rentas.evento_canal_importado`/
// `rentas.bloqueo_exportado`, ver migrations/008_ical_sync_schema.sql), nunca
// comparte código de autorización con las rutas de staff de calendario/finanzas.
//
// El motor (./motor.ts) SÍ reutiliza literalmente `crearReservaConfirmada`/
// `modificarFechasReserva`/`cancelarOcupacion` de ../aplicacion/reservas.ts (recibidas
// como `EjecutorTransaccional`, structural typing con el mismo `TenantDbSession` que
// ya usan las rutas de reservas.ts/bloqueos.ts) — este repository NUNCA reimplementa
// esa lógica transaccional, solo cubre el bookkeeping de sync que esas funciones no
// conocen (versión por UID, anti-eco, estado de cuarentena por feed).
import type { RangoFechas } from "../tipos.ts";
import type { UidActivoInterno } from "./reconciliacion.ts";
import type { EstadoFeedCanal } from "./cuarentena.ts";
import type { BloqueoExportadoPrevio, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./tipos.ts";

export interface RentasCalendarSyncRepository {
  // ---- Zona horaria de la property (rentas.property_config, migrations/001) ----
  /** `resolverFechaLocal` (../ical/resolver-fecha.ts) SIEMPRE necesita la zona
   * horaria IANA de la property para convertir un DATE-TIME de un feed externo a la
   * fecha de calendario correcta -- ninguna otra parte de `RentasRepository` expone
   * hoy esta columna (`rentas.property_config.zona_horaria`), así que se cubre aquí,
   * junto al resto del bookkeeping que el motor de sync necesita antes de correr un
   * ciclo. `"UTC"` como fallback nunca debería alcanzarse en producción
   * (`zona_horaria` es NOT NULL en el esquema) -- solo protege una fixture de prueba
   * que no la sembró explícitamente.
   */
  findZonaHorariaPropiedad(propertyId: string): Promise<string>;

  // ---- Configuración de feed externo por (unidad, canal) ----
  connectFeed(input: NewFeedExternoInput): Promise<{ id: string }>;
  /** `false` si no había ningún feed conectado para ese (unidad, canal) — la ruta HTTP
   * lo trata como 404, nunca como error. */
  disconnectFeed(propertyId: string, unidadId: string, canalId: string): Promise<boolean>;
  findFeed(propertyId: string, unidadId: string, canalId: string): Promise<FeedExternoRecord | null>;
  findFeedById(propertyId: string, feedId: string): Promise<FeedExternoRecord | null>;
  listFeedsForUnidad(propertyId: string, unidadId: string): Promise<FeedExternoRecord[]>;
  /** Todos los feeds activos de la plataforma — usado por el cron de reconciliación
   * (ver apps/api/.../ical-sync-cron.ts), nunca acotado a una sola organización. */
  listFeedsActivos(): Promise<FeedExternoRecord[]>;
  persistFeedSyncState(feedId: string, estado: EstadoFeedCanal, etag: string | null, ultimaModificacionHttp: string | null, drift: number | undefined, ultimoResumen: unknown): Promise<void>;

  // ---- Bookkeeping de versión por evento importado (UID -> SEQUENCE/DTSTAMP/hash) ----
  findVersionPrevia(unidadId: string, canalId: string, uid: string): Promise<VersionPreviaAlmacenada | null>;
  upsertEventoImportado(unidadId: string, canalId: string, entrada: EntradaUpsertEventoImportado): Promise<void>;
  /** UIDs que el sistema cree activos AHORA MISMO para (unidad, canal) — la fila de
   * bookkeeping sigue apuntando a una ocupación que no está cancelada. Se calcula
   * DESPUÉS del bucle de aplicación incremental del ciclo, así que ya refleja
   * cualquier `CANCELLED` explícito que ese mismo ciclo acabe de procesar. */
  listUidsActivosInternos(unidadId: string, canalId: string): Promise<UidActivoInterno[]>;
  /** Ocupación activa (capa='reserva', bloqueante, no cancelada) creada por ESTE canal
   * con `external_id = uid` y el MISMO rango exacto — recuperación de bookkeeping
   * perdido tras un crash entre el COMMIT de `crearReservaConfirmada` y el de
   * `upsertEventoImportado` (no son atómicos entre sí, ver ./motor.ts). */
  buscarOcupacionActivaParaRecuperarBookkeeping(unidadId: string, canalId: string, externalId: string, rango: RangoFechas): Promise<string | null>;
  /** Nº de ocupaciones activas bloqueantes de capa='reserva' creadas por ESTE canal —
   * señal de "¿esta unidad tenía eventos activos DE ESTE CANAL?" para la heurística de
   * "vacío inesperado" de cuarentena.ts. */
  contarOcupacionesActivasDelCanal(unidadId: string, canalId: string): Promise<number>;

  // ---- Anti-eco (capas 2 y 3) ----
  /** Hashes de bloqueos exportados recientemente a CUALQUIER canal para esta unidad
   * (capa 2 del anti-eco) — sin filtrar por canal a propósito, ver ./anti-eco.ts. */
  listHashesExportadosRecientes(unidadId: string): Promise<string[]>;
  /** Canales a los que se exportó algún bloqueo cuyo rango coincide exactamente con
   * `rango` (capa 3 del anti-eco) — sin filtrar por el canal de origen del ciclo
   * actual, ver ./anti-eco.ts. */
  listCanalesExportadosDeRango(unidadId: string, rango: RangoFechas): Promise<string[]>;

  // ---- Export ----
  listOcupacionesActivasBloqueantes(unidadId: string): Promise<OcupacionActivaExportable[]>;
  findBloqueoExportadoPrevio(ocupacionId: string, canalId: string): Promise<BloqueoExportadoPrevio | null>;
  upsertBloqueoExportado(organizationId: string, propertyId: string, ocupacionId: string, canalId: string, uidExportado: string, hashContenido: string, sequence: number): Promise<void>;
}

export type { BloqueoExportadoPrevio, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./tipos.ts";
