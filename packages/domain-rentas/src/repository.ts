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
  BloqueoRecord,
  CandidataConciliacion,
  CanalRecord,
  ConfiguracionComisionCanal,
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
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  ReglaCanal,
  ReglaMinStayRecord,
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
  loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null>;
  loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null>;

  // ---- Finanzas / movimiento por reserva (flujo 3) ----
  findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null>;
  /** Resuelve la regla vigente: busca primero una específica de `propertyId`, cae a
   *  la regla global del tenant (`property_id IS NULL`) si no hay una específica —
   *  mismo orden de búsqueda que `buscarReglaComisionCanal` del origen. Lanza si no
   *  hay ninguna regla configurada (fail-closed: nunca asume una comisión de 0%). */
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
}

export type {
  CandidataConciliacion,
  CanalRecord,
  ConfiguracionComisionCanal,
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
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  ReglaCanal,
  ReglaMinStayRecord,
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
