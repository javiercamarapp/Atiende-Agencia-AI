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
import type { EventoBitacora, OpcionesReclamo, ResultadoReclamo } from "./lease.ts";
import type { AccionConflicto } from "./conflictos.ts";
import type { FeedMonitorRecord, FiltroEstadoConflictos, HistorialConflicto, ListadoBitacora, ListadoConflictos, ResultadoDecisionConflicto, ResultadoMarcarResuelto } from "./monitor.ts";
import type {
  BloqueoExportadoPrevio,
  EntradaUpsertBloqueoExportado,
  EntradaUpsertEventoImportado,
  FeedExternoRecord,
  NewFeedExternoInput,
  OcupacionActivaExportable,
  ResultadoListarFeedTokens,
  ResultadoReclamoManual,
  ResultadoResolverFeedToken,
  ResultadoRotarFeedToken,
  RotarFeedTokenInput,
  VersionPreviaAlmacenada,
} from "./tipos.ts";

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
  /** Batch de `findBloqueoExportadoPrevio` -- hallazgo de auditoría (rubro 10,
   * "performance y escalabilidad", severidad MEDIA: "feed iCal público... ejecuta
   * 3+2N queries por request"). Una sola consulta agregada para TODAS las ocupaciones
   * activas de la unidad (`WHERE ocupacion_id = ANY($1)`), en vez de una query por
   * ocupación dentro de un bucle -- ver ./motor.ts::exportarFeedParaUnidad, que ya NO
   * llama a `findBloqueoExportadoPrevio` uno por uno. Devuelve un Map indexado por
   * `ocupacionId` (solo las que ya tenían fila previa); una ocupación ausente del Map
   * nunca se exportó antes a este canal. */
  findBloqueosExportadosPrevios(ocupacionIds: readonly string[], canalId: string): Promise<Map<string, BloqueoExportadoPrevio>>;
  /** Batch de `upsertBloqueoExportado` -- mismo hallazgo que
   * `findBloqueosExportadosPrevios`, ver comentario de arriba. Una sola sentencia
   * INSERT ... ON CONFLICT multi-fila para TODOS los bloqueos exportados del ciclo,
   * en vez de un upsert por bloqueo. Sin efecto si `entradas` viene vacío. */
  upsertBloqueosExportadosBatch(organizationId: string, propertyId: string, canalId: string, entradas: readonly EntradaUpsertBloqueoExportado[]): Promise<void>;

  // ---- Rn-01: claim/lease por feed, backoff y bitácora (migrations/024) ----
  // Los tres métodos de abajo son de SOLO SISTEMA (sesión con auth.uid() NULL, la del
  // cron) y cada uno debe correr en SU PROPIA transacción corta: ninguno depende de los
  // demás. Todos degradan sin lanzar contra una base sin la migración 024 (SAVEPOINT +
  // SQLSTATE 42883/42P01/42703): `reclamarFeeds` devuelve `disponible: false`, los otros
  // dos devuelven `false`.
  /** Reclama hasta `limite` feeds activos con lease libre, fuera de backoff y fuera del
   * piso de espaciamiento. Dos llamadas concurrentes nunca reciben el mismo feed. */
  reclamarFeeds(opciones: OpcionesReclamo): Promise<ResultadoReclamo>;
  /** Libera el lease con el token vigente; tras `exito: false` fija el backoff por feed.
   * `false` si el token ya no es el vigente o la base no tiene la migración. */
  liberarFeed(feedId: string, leaseToken: string, exito: boolean): Promise<boolean>;
  /** Registra un evento de bitácora/alerta. `false` si la base no tiene la migración. */
  registrarEventoBitacora(feedId: string, evento: EventoBitacora): Promise<boolean>;
  /** Reinicia el backoff de un feed (se llama al reconectarlo con otra URL). Best-effort. */
  reiniciarBackoffFeed(feedId: string): Promise<void>;

  // ---- Rn-01/Rn-02: lecturas y acciones del monitor (staff, sesión por request) ----
  /** Estado de TODOS los feeds de la property. Contra una base sin 024, sin las columnas
   * de lease/backoff (quedan en null). */
  listarFeedsMonitor(propertyId: string): Promise<FeedMonitorRecord[]>;
  /** Conflictos de la property filtrados por estado (`abiertos` = sin decidir). Contra una base
   * sin la migración 026 no existe `ignorado` ni motivo: los cerrados salen como `resuelto`. */
  listarConflictos(propertyId: string, opciones: { estado: FiltroEstadoConflictos; limite: number }): Promise<ListadoConflictos>;
  /** Decide un conflicto abierto a nombre de `actorUserId`: "resuelto" (exige que el solape ya no
   * exista) o "ignorado" (exige `motivo`). Nunca cancela ni edita una reserva. Contra una base sin
   * 026 solo "resuelto" cae al UPDATE directo de 024 (sin bitácora ni verificación de solape);
   * "ignorado" responde `no_disponible`. */
  decidirConflicto(propertyId: string, conflictoId: string, actorUserId: string, decision: { accion: AccionConflicto; motivo: string | null }): Promise<ResultadoDecisionConflicto>;
  /** Bitácora de decisiones de un conflicto (más antigua primero). `disponible: false` sin 026. */
  listarHistorialConflicto(propertyId: string, conflictoId: string): Promise<HistorialConflicto>;
  listarBitacora(propertyId: string, opciones: { soloAlertasAbiertas: boolean; limite: number }): Promise<ListadoBitacora>;
  atenderAlerta(propertyId: string, alertaId: string, actorUserId: string): Promise<ResultadoMarcarResuelto>;

  // ---- Rn-13: token rotable de la URL de exportación (migración 037) ----
  // Contra una base sin la migración 037 los tres devuelven `disponible: false` (SAVEPOINT +
  // SQLSTATE 42883/42P01/42703): la ruta cae a la URL por UUID y responde un "aún no disponible" honesto.
  /** Revoca el token vigente de (unidad, canal) y crea uno nuevo con `tokenHash`, atómicamente. Staff (sesión por
   * request): la base exige acceso a la property y un rol de escritura de calendario. */
  rotarFeedToken(input: RotarFeedTokenInput): Promise<ResultadoRotarFeedToken>;
  /** Tokens vigentes (uno por unidad y canal) de la property, o solo de `unidadId`; sin hash ni valor en claro. */
  listarFeedTokens(propertyId: string, unidadId?: string): Promise<ResultadoListarFeedTokens>;
  /** SOLO SISTEMA (ruta pública del feed, auth.uid() NULL): resuelve un hash a (unidad, canal) y registra el último
   * acceso (a lo más una escritura por minuto y token). Ignora los tokens revocados. */
  resolverFeedToken(tokenHash: string): Promise<ResultadoResolverFeedToken>;

  // ---- Rn-P3-23: "Sincronizar ahora" (migración 037) ----
  /** SOLO SISTEMA: reclama UN feed concreto con el lease de 024, ignorando backoff y piso de espaciamiento pero
   * nunca un lease vigente. Se libera con `liberarFeed`. */
  reclamarFeedManual(feedId: string, leaseSegundos: number): Promise<ResultadoReclamoManual>;
}

export type { BloqueoExportadoPrevio, EntradaUpsertBloqueoExportado, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./tipos.ts";
