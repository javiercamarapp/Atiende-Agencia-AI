// Puerto de acceso a datos de domain-rentas — mismo patrón dual de adaptador que
// domain-hoteles/domain-restaurantes: un puerto TS explícito, con un adaptador real en
// memoria (tests determinísticos) y un adaptador real de Postgres (sobre
// TenantDbSession, contra las migraciones de migrations/001-003). Ninguna función de
// negocio de las rutas de apps/api toca SQL directamente para estas operaciones —
// solo pasan por aquí.
//
// Deliberadamente acotado a los 3 flujos elegidos (ver diseño Fase 1 §3): la
// transacción principal de crear/modificar/cancelar una reserva NO se envuelve aquí —
// igual que domain-hoteles no envuelve folioEngine en su repository, aquí tampoco se
// envuelve aplicacion/reservas.ts. La ruta le pasa el `TenantDbSession` directo (que ya
// satisface `EjecutorTransaccional` por structural typing) a
// crearReservaConfirmada/modificarFechasReserva/cancelarOcupacion; este repository solo
// cubre las lecturas/escrituras auxiliares (resolver unidad/canal, adjuntar huésped
// mínimo, pricing de solo lectura, y el movimiento financiero por reserva).
import type { RangoFechas } from "./tipos.ts";
import type {
  ActualizarLineaImportadaInput,
  BloqueoRecord,
  CandidataImportacion,
  LineaColaImportacion,
  LineaImportadaExistente,
  MovimientoEnRevision,
  NewImportacionPagosInput,
  NewLineaImportadaInput,
  OrganizacionConReservasSinMovimiento,
  ReservaSinMovimiento,
  CandidataConciliacion,
  CanalRecord,
  ConfiguracionComisionCanal,
  ConfiguracionPricingUnidad,
  ContextoPricingUnidad,
  DescuentoDuracionRecord,
  EmailOutboxJobRow,
  IncidenciaMantenimientoRecord,
  ItemInventarioRecord,
  MessagingOutboxChannel,
  MovimientoFinancieroReserva,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  UpdateDescuentoDuracionInput,
  UpdateReglaCanalInput,
  UpdateReglaMinStayInput,
  UpdateTemporadaInput,
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  RegistrarAuditoriaInput,
  ReglaCanal,
  ReglaMinStayRecord,
  RentasAuditLogFiltro,
  RentasAuditLogPagina,
  RentasAuditLogPaginacion,
  RentasOrganizationSummary,
  RentasPropertySummary,
  ReservaParaStatement,
  ReservaProximaCheckIn,
  TareaListFiltro,
  TareaOperativaDetalle,
  TareaOperativaRecord,
  TemporadaRecord,
  UltimaVersionOwnerStatement,
  UnidadRecord,
} from "./types.ts";

/** Página de `listOcupacionesPage` -- mismo criterio de forma que
 * `CitasRepository::CustomerPage` (@atiende/domain-citas): `total` es el conteo
 * completo (no solo `items.length`), `nextOffset` es `null` cuando ya no queda
 * página siguiente. */
export interface OcupacionCalendarioPage {
  readonly items: readonly OcupacionCalendarioItem[];
  readonly total: number;
  readonly nextOffset: number | null;
}

/** Opciones de `listOcupacionesVentana`: ventana `[desde, hasta)` de fechas de calendario (`YYYY-MM-DD`). */
export interface OcupacionVentanaOpciones {
  readonly desde: string;
  readonly hasta: string;
  /** Solo esta unidad; ausente = todas las de la property. */
  readonly unidadId?: string;
  /** Tope de filas devueltas (el `total` real se devuelve aparte). */
  readonly limit: number;
}

export interface OcupacionCalendarioVentana {
  readonly items: readonly OcupacionCalendarioItem[];
  /** Total de ocupaciones activas que tocan la ventana (puede ser mayor que `items.length`). */
  readonly total: number;
}

export interface RentasRepository {
  // ---- Calendario / anti-doble-reserva (flujo 1) ----
  findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null>;
  findCanalPorCodigo(codigo: string): Promise<CanalRecord | null>;
  /** Resumen mínimo de una ocupación, usado por la ruta ANTES de invocar
   *  modificarFechasReserva/cancelarOcupacion — defensa en profundidad, nunca confía
   *  en que el cliente "sabe" que una reserva es directa (mismo criterio que
   *  `exigirReservaDirecta` del origen). */
  findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): Promise<OcupacionResumen | null>;
  insertGuestMinimo(input: NewGuestMinimoInput): Promise<{ id: string }>;
  attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): Promise<void>;
  /** Fase 4 -- `GET .../bloqueos`: lista bloqueos (capa='bloqueo' únicamente,
   *  BLOQUEO_PROPIETARIO/MANTENIMIENTO/BUFFER_LIMPIEZA) de una unidad, activos y
   *  cancelados, ordenados por fecha de inicio. */
  listBloqueos(propertyId: string, unidadId: string): Promise<readonly BloqueoRecord[]>;

  // ---- Pricing / cotización (flujo 2) — SOLO lectura, ninguna escritura de precio ----
  /** "Vigente hoy" se resuelve con el día de NEGOCIO (`@atiende/core-tenancy::
   *  hoyFechaNegocio()`) dentro de cada implementación -- nunca con `current_date`/el
   *  reloj UTC crudo del proceso (bug real, ver comentario de cabecera de
   *  `PostgresRentasRepository.loadPricingContext`). */
  loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null>;
  loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null>;

  // ---- Finanzas / movimiento por reserva (flujo 3) ----
  findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null>;
  /** Resuelve la regla vigente: busca primero una específica de `propertyId`, cae a
   *  la regla global del tenant (`property_id IS NULL`) si no hay una específica —
   *  mismo orden de búsqueda que `buscarReglaComisionCanal` del origen. Sin regla:
   *  una reserva SIN canal externo (canal nulo o "manual") usa el default seguro de 0 pb
   *  (`reglaComisionPorDefecto`); un canal externo lanza `ReglaComisionCanalNoConfiguradaError`
   *  (error de negocio, nunca asume una comisión de 0%). */
  findReglaComisionCanal(propertyId: string, canalId: string | null): Promise<ConfiguracionComisionCanal>;
  insertReservaFinanciero(input: NewReservaFinancieroInput): Promise<{ id: string; createdAt: string }>;
  findReservaFinanciero(propertyId: string, ocupacionId: string): Promise<MovimientoFinancieroReserva | null>;

  // ---- Pricing CRUD (flujo 4, Fase 2) ----
  /** Moneda ya en uso por la unidad (cualquier `tarifa_base` con otra `vigente_desde` o
   *  cualquier `tarifa_temporada`), o `null` si la unidad no tiene pricing configurado
   *  todavía -- guardia de "nunca mezclar monedas por unidad" (ver diseño §3.1). */
  findMonedaExistentePricing(unidadId: string, excluirVigenteDesde?: string): Promise<string | null>;
  upsertTarifaBase(input: NewTarifaBaseInput): Promise<{ id: string }>;
  listTemporadas(unidadId: string): Promise<TemporadaRecord[]>;
  insertTemporada(input: NewTemporadaInput): Promise<{ id: string }>;
  listDescuentosDuracion(unidadId: string): Promise<DescuentoDuracionRecord[]>;
  upsertDescuentoDuracion(input: NewDescuentoDuracionInput): Promise<{ id: string }>;
  listReglasMinStay(unidadId: string): Promise<ReglaMinStayRecord[]>;
  insertReglaMinStay(input: NewReglaMinStayInput): Promise<{ id: string }>;
  upsertReglaCanalPricing(input: NewReglaCanalPricingInput): Promise<{ id: string }>;

  // ---- Pricing: lectura de la configuracion y edicion/borrado por id (Rn-23) ----
  /** Toda la configuracion de la unidad. `hoy` (YYYY-MM-DD, dia de negocio) decide cual
   *  tarifa base es la vigente. Solo lee tablas de 002_pricing_schema.sql: no depende
   *  de ninguna migracion posterior. */
  loadConfiguracionPricing(unidadId: string, hoy: string): Promise<ConfiguracionPricingUnidad>;
  /** Los `update*`/`delete*` devuelven `false` si no existe una fila con ese id en la unidad
   *  (o si RLS la oculta). `delete*` de temporada/descuento/min-stay requiere la migracion
   *  030: sin ella Postgres responde 42501 (la ruta lo traduce a 503 honesto). */
  updateTemporada(input: UpdateTemporadaInput): Promise<boolean>;
  deleteTemporada(unidadId: string, id: string): Promise<boolean>;
  updateDescuentoDuracion(input: UpdateDescuentoDuracionInput): Promise<boolean>;
  deleteDescuentoDuracion(unidadId: string, id: string): Promise<boolean>;
  updateReglaMinStay(input: UpdateReglaMinStayInput): Promise<boolean>;
  deleteReglaMinStay(unidadId: string, id: string): Promise<boolean>;
  updateReglaCanalPricing(input: UpdateReglaCanalInput): Promise<boolean>;
  deleteReglaCanalPricing(unidadId: string, id: string): Promise<boolean>;

  // ---- Owner statement (flujo 5, Fase 2) ----
  /** `null` si el owner no existe o no tiene ninguna unidad en esta property (defensa
   *  en profundidad: nunca generar un statement "vacío de sentido" para un owner sin
   *  presencia real en la property -- ver diseño §4.1, alcance por property). */
  findOwnerConUnidadesEnProperty(propertyId: string, ownerId: string): Promise<OwnerRecord | null>;
  findMovimientosPeriodoParaOwner(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<ReservaParaStatement[]>;
  findUltimaVersionOwnerStatement(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<UltimaVersionOwnerStatement | null>;
  insertOwnerStatement(input: NewOwnerStatementInput): Promise<{ id: string; generadoEn: string }>;
  listOwnerStatements(propertyId: string, ownerId: string): Promise<OwnerStatementSummary[]>;
  findOwnerStatementDetalle(propertyId: string, statementId: string): Promise<OwnerStatementDetalle | null>;

  // ---- Payout / conciliación (flujo 6, Fase 2, alcance recortado) ----
  findCandidatasConciliacion(propertyId: string, canalId: string): Promise<CandidataConciliacion[]>;
  insertPayout(input: NewPayoutInput): Promise<{ id: string; creadoEn: string }>;
  findPayoutDetalle(propertyId: string, payoutId: string): Promise<PayoutDetalle | null>;

  // ---- Importacion del reporte de pagos de la OTA y aviso de sin movimiento (Rn-P3-06/07; requieren la migracion 035) ----
  // Todos lanzan el error de Postgres tal cual (42703/42P01 contra una base sin migrar): quien los usa abre el SAVEPOINT y degrada.
  /** Serializa dos importaciones simultaneas del mismo canal en la misma property (advisory lock de transaccion). */
  bloquearImportacionPagos(propertyId: string, canalId: string): Promise<void>;
  /** Reservas de la property en ese canal con alguno de esos codigos (todas las de capa='reserva', cancelada o no). */
  findCandidatasImportacion(propertyId: string, canalId: string, codigos: readonly string[]): Promise<readonly CandidataImportacion[]>;
  findLineasImportadas(propertyId: string, canalId: string, huellas: readonly string[]): Promise<readonly LineaImportadaExistente[]>;
  insertImportacionPagos(input: NewImportacionPagosInput): Promise<{ id: string; creadoEn: string }>;
  insertLineaImportada(input: NewLineaImportadaInput): Promise<void>;
  actualizarLineaImportada(input: ActualizarLineaImportadaInput): Promise<void>;
  listColaImportacion(propertyId: string, limit: number): Promise<readonly LineaColaImportacion[]>;
  /** Reservas `capa='reserva'`, `estado='confirmado'` con check-in en `[desde, hasta)` y sin `reserva_financiero`. `total` es el conteo completo. */
  listReservasSinMovimiento(propertyId: string, desde: string, hasta: string, limit: number): Promise<{ readonly total: number; readonly items: readonly ReservaSinMovimiento[] }>;
  listMovimientosEnRevision(propertyId: string, limit: number): Promise<readonly MovimientoEnRevision[]>;
  /** Quita `requiere_revision` de un movimiento de la property. `false` si no existe o no estaba marcado. */
  marcarMovimientoRevisado(propertyId: string, ocupacionId: string): Promise<boolean>;
  /** Barrido de SISTEMA (todas las organizaciones): cuenta reservas confirmadas con check-in en `[desde, hasta)` sin movimiento. */
  listOrganizacionesConReservasSinMovimiento(desde: string, hasta: string): Promise<readonly OrganizacionConReservasSinMovimiento[]>;

  // ---- Correo transaccional al huésped (Fase 9) — ver
  // reserva-email-notifications.ts/email-dispatch.ts/checkin-reminders.ts ----
  /** Defensa en profundidad: `organizationId` acota la búsqueda (mismo criterio que
   *  `domain-citas::findAppointmentForOrganization`) — nunca resuelve una ocupación de
   *  otro tenant a partir de solo el id. */
  findOcupacionParaCorreo(organizationId: string, ocupacionId: string): Promise<OcupacionParaCorreo | null>;
  /** Reservas directas `capa='reserva' AND estado='confirmado'` cuyo check-in cae en
   *  `[desdeFecha, hastaFecha]` (ambos extremos inclusivos, `YYYY-MM-DD`) y que
   *  todavía no recibieron el recordatorio (`recordatorio_checkin_enviado_en IS
   *  NULL`) — barrido GLOBAL de la plataforma (sin loop por organización, mismo
   *  criterio que `rentasIcalSyncCronRoutes::listFeedsActivos`), nunca acotado a un
   *  solo tenant. */
  listReservasProximasACheckIn(desdeFecha: string, hastaFecha: string): Promise<readonly ReservaProximaCheckIn[]>;
  /** Rn-P3-10 -- recordatorio horario: reservas confirmadas CON correo valido del huesped y sin recordatorio cuyo check-in (a las `horaCheckIn`, `HH:MM`, en la
   *  zona horaria de SU property; `zonaPorDefecto` si la property no tiene configuracion) cae entre `ahora + desdeHoras` y `ahora + hastaHoras`.
   *  Barrido GLOBAL de la plataforma, igual que `listReservasProximasACheckIn`. */
  listReservasProximasACheckInVentana(ahora: Date, desdeHoras: number, hastaHoras: number, horaCheckIn: string, zonaPorDefecto: string): Promise<readonly ReservaProximaCheckIn[]>;
  marcarRecordatorioCheckInEnviado(ocupacionId: string, enviadoEnIso: string): Promise<void>;
  enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: MessagingOutboxChannel, eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;

  // ---- Fase 12 — descubrimiento de organización/property para el panel web de staff ----

  /** `null` si no existe una organización de vertical 'rentas' con ese slug — mismo
   *  contrato que `HotelesRepository.findOrganizationBySlug` (domain-hoteles), ver
   *  types.ts::RentasOrganizationSummary para por qué existe. */
  findOrganizationBySlug(slug: string): Promise<RentasOrganizationSummary | null>;
  /** Properties ACTIVAS de una organización de rentas — insumo del selector de
   *  property del panel de staff (RentasShell.tsx), mismo criterio que
   *  `HotelesRepository.listPropertiesForOrganization`. */
  listPropertiesForOrganization(organizationId: string): Promise<readonly RentasPropertySummary[]>;

  // ---- Fase 13 — calendario visual del panel de staff (GET .../unidades,
  // GET .../unidades/:unidadId/ocupaciones) ----

  /** Unidades de una property, para el selector de unidad del calendario -- mismo
   *  criterio de alcance que `listPropertiesForOrganization` (Fase 12): plumbing
   *  mínimo indispensable para que el panel web pueda enumerar lo que existe antes de
   *  poder pedir nada más específico. */
  listUnidades(propertyId: string): Promise<readonly UnidadRecord[]>;
  /** El listado que le faltaba al calendario: TODA ocupación de la unidad (reserva de
   *  canal Y bloqueo, activa Y cancelada), ordenada por fecha de inicio -- a
   *  diferencia de `listBloqueos` (Fase 4, solo `capa='bloqueo'`), esta es la vista
   *  UNIFICADA que un calendario real necesita para pintar ambas capas en una sola
   *  lista. Ver types.ts::OcupacionCalendarioItem. */
  listOcupaciones(propertyId: string, unidadId: string): Promise<readonly OcupacionCalendarioItem[]>;
  /** Versión PAGINADA de `listOcupaciones`, para `GET .../unidades/:unidadId/
   * ocupaciones` (el calendario que el panel navega) -- hallazgo de auditoría (rubro
   * 10, "performance y escalabilidad", severidad BAJA: "listados sin paginación en 4
   * verticales"). Una unidad con años de operación acumula cientos de ocupaciones
   * (reservas Y bloqueos, activas Y canceladas); la query ahora está acotada por
   * `limit`/`offset` reales en vez de traer TODO el historial en un solo array.
   * `listOcupaciones` (arriba) se queda intacta -- hoy no tiene otro consumidor, pero
   * cambiar su contrato es una decisión distinta a agregar el camino paginado que la
   * ruta HTTP necesita. */
  listOcupacionesPage(propertyId: string, unidadId: string, opts: { readonly limit: number; readonly offset: number }): Promise<OcupacionCalendarioPage>;
  /** Rn-06 -- ocupaciones ACTIVAS (no canceladas) de la property (o de una unidad) cuyo rango toca la ventana
   *  `[desde, hasta)`, ordenadas por inicio. Es la lectura del calendario visual: acotada por ventana y por `limit`
   *  (nunca el historial completo). Solo lectura, sin columnas ni tablas nuevas. */
  listOcupacionesVentana(propertyId: string, opts: OcupacionVentanaOpciones): Promise<OcupacionCalendarioVentana>;

  // ---- Fase 17 — panel operativo del rol `limpieza` (tareas/checklist/inventario/
  // incidencias). Las ESCRITURAS de este módulo (asignar/completar checklist/
  // completar tarea/registrar incidencia) NO viven aquí -- siguen pasando por las
  // funciones de aplicación de ../limpieza/aplicacion/tareas.ts con el
  // `TenantDbSession` del request DIRECTO, mismo patrón exacto que
  // reservas.ts/bloqueos.ts (ver el comentario de cabecera de este archivo). Este
  // repository solo cubre las LECTURAS que ese panel necesita. ----

  /** `GET .../tareas`: tareas de una property, opcionalmente filtradas por
   *  asignación/estado -- ver types.ts::TareaListFiltro. */
  listTareas(propertyId: string, filtro?: TareaListFiltro): Promise<readonly TareaOperativaRecord[]>;
  /** `GET .../tareas/:tareaId`: detalle de una tarea + su checklist completo, para la
   *  vista "mis tareas de hoy" del rol `limpieza`. `null` si la tarea no existe o no
   *  pertenece a esta property (defensa en profundidad, mismo criterio que
   *  `findUnidad`). */
  findTareaDetalle(propertyId: string, tareaId: string): Promise<TareaOperativaDetalle | null>;
  /** Defensa en profundidad ANTES de invocar `completarChecklistItem`: nunca confiar
   *  en que el cliente "sabe" que un `itemId` pertenece a `tareaId`/`propertyId` --
   *  mismo criterio que `findOcupacion` en reservas.ts. */
  findChecklistItem(propertyId: string, tareaId: string, itemId: string): Promise<{ id: string } | null>;
  /** `GET .../unidades/:unidadId/inventario`: catálogo de ropa blanca/consumibles de
   *  una unidad -- insumo para elegir qué `itemInventarioId` consumir al completar
   *  una tarea (H-052). */
  listItemsInventario(propertyId: string, unidadId: string): Promise<readonly ItemInventarioRecord[]>;
  /** `GET .../unidades/:unidadId/incidencias`: incidencias de mantenimiento
   *  reportadas sobre una unidad (H-055), más recientes primero. */
  listIncidencias(propertyId: string, unidadId: string): Promise<readonly IncidenciaMantenimientoRecord[]>;

  // ---- r5 — bitácora de auditoría del staff (ver migrations/021_rentas_audit_log.sql) ----

  /** Registra una fila de auditoría DENTRO de la transacción compartida del request
   *  (nunca abre su propia transacción, nunca debe romper ni revertir la acción de
   *  negocio que audita) -- ver el contrato completo en el comentario de cabecera de
   *  `PostgresRentasRepository.registrarAuditoria`. */
  registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void>;
  /** `GET .../auditoria`: bitácora paginada de UNA organización, opcionalmente
   *  filtrada por tipo de entidad y rango de fechas. Solo la ruta HTTP decide quién
   *  puede llamarla (owner/admin de la organización) -- este método no re-valida el
   *  rol, la RLS de `rentas.audit_log` sí lo hace como defensa en profundidad. */
  listAuditoria(organizationId: string, filtro: RentasAuditLogFiltro, paginacion: RentasAuditLogPaginacion): Promise<RentasAuditLogPagina>;
}

export type {
  ActualizarLineaImportadaInput,
  CandidataImportacion,
  LineaColaImportacion,
  LineaImportadaExistente,
  MotivoRevisionMovimiento,
  MovimientoEnRevision,
  NewImportacionPagosInput,
  NewLineaImportadaInput,
  OrganizacionConReservasSinMovimiento,
  OrigenMovimiento,
  ReservaSinMovimiento,
  ResultadoLineaImportacion,
  CandidataConciliacion,
  CanalRecord,
  ConfiguracionComisionCanal,
  ConfiguracionPricingUnidad,
  ContextoPricingUnidad,
  DescuentoDuracionRecord,
  EmailOutboxJobRow,
  IncidenciaMantenimientoRecord,
  ItemInventarioRecord,
  MessagingOutboxChannel,
  MovimientoFinancieroReserva,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  ReglaCanalRecord,
  TarifaBaseRecord,
  TemporadaConfigRecord,
  UpdateDescuentoDuracionInput,
  UpdateReglaCanalInput,
  UpdateReglaMinStayInput,
  UpdateTemporadaInput,
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  RegistrarAuditoriaInput,
  ReglaCanal,
  ReglaMinStayRecord,
  RentasAuditLogFiltro,
  RentasAuditLogPagina,
  RentasAuditLogPaginacion,
  RentasAuditLogRow,
  RentasOrganizationSummary,
  RentasPropertySummary,
  ReservaParaStatement,
  ReservaProximaCheckIn,
  TareaListFiltro,
  TareaOperativaDetalle,
  TareaOperativaRecord,
  TemporadaRecord,
  UltimaVersionOwnerStatement,
  UnidadRecord,
} from "./types.ts";
