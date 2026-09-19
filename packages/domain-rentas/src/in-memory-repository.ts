// InMemoryRentasRepository — implementación real (no un mock) de `RentasRepository`,
// con las mismas restricciones de integridad que el DDL real de migrations/002-005
// (p. ej. `reserva_financiero.ocupacion_id UNIQUE`, `tarifa_base (unidad_id,
// vigente_desde) UNIQUE`, `owner_statement (owner_id, property_id, periodo_inicio,
// periodo_fin, version) UNIQUE`). Sirve para tests determinísticos y como fallback
// dev/CI sin Postgres real — mismo rol que `InMemoryHotelesRepository`/
// `InMemoryRestaurantesRepository`.
//
// Las lecturas/escrituras de calendario (findUnidad/findCanalPorCodigo/findOcupacion/
// insertGuestMinimo/attachGuestToOcupacion/findOcupacionParaMovimiento) delegan a un
// `InMemoryRentasCalendarStore` — el MISMO que usa `InMemoryRentasTenancyEngine` para
// resolver las queries crudas de `aplicacion/reservas.ts` cuando ambos se construyen
// compartiendo una instancia (ver apps/api/tests/rentas-fixtures.ts): en Postgres real
// ambos caminos leen/escriben la misma tabla `rentas.ocupacion`, así que la fixture de
// prueba reproduce esa misma propiedad en vez de mantener dos copias divergentes.
//
// Fase 2: el pricing (tarifa_base/tarifa_temporada/tarifa_descuento_duracion/
// tarifa_min_stay/tarifa_regla_canal) se modela con las MISMAS tablas granulares que
// Postgres real -- `loadPricingContext` RECONSTRUYE el `ContextoPricingUnidad` desde
// esas tablas (igual que `PostgresRentasRepository.loadPricingContext`), nunca desde un
// blob pre-armado -- así, una escritura real (POST tarifa-base/temporadas/...) se
// refleja de inmediato en una cotización posterior, exactamente como en producción.
import { randomUUID } from "node:crypto";
import { InMemoryRentasCalendarStore } from "./calendar-store.ts";
import type { OcupacionCalendarioPage, RentasRepository } from "./repository.ts";
import type { LineaOwnerStatement, TotalesOwnerStatement } from "./finanzas/statement.ts";
import type { CandidataConciliacion, LineaConciliada, ResumenConciliacion } from "./finanzas/conciliacion.ts";
import type { RangoFechas } from "./tipos.ts";
import type {
  BloqueoRecord,
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

interface StoredReglaComisionCanal {
  propertyId: string | null; // null = regla global del tenant
  canalId: string | null; // null = regla por defecto sin canal específico
  config: ConfiguracionComisionCanal;
}

interface StoredReservaFinanciero {
  id: string;
  organizationId: string;
  propertyId: string;
  ocupacionId: string;
  createdAt: string;
  movimiento: MovimientoFinancieroReserva;
}

interface StoredTarifaBase {
  id: string;
  precioNocheCentavos: number;
  moneda: string;
  vigenteDesde: string;
}

interface StoredTemporada {
  id: string;
  nombre: string;
  rango: RangoFechas;
  precioNocheCentavos: number;
  moneda: string;
}

interface StoredDescuentoDuracion {
  id: string;
  nochesMinimas: number;
  porcentajeDescuentoBasisPoints: number;
  fuente: string;
}

interface StoredReglaMinStay {
  id: string;
  rango: RangoFechas;
  diaSemanaCheckIn: number | null;
  nochesMinimas: number;
}

interface StoredReglaCanalPricing {
  id: string;
  canalId: string;
  markupBasisPoints: number;
  activo: boolean;
}

interface StoredOwnerStatement {
  id: string;
  organizationId: string;
  propertyId: string;
  ownerId: string;
  periodo: RangoFechas;
  version: number;
  moneda: string;
  totales: TotalesOwnerStatement;
  lineas: LineaOwnerStatement[];
  hashContenido: string;
  motivoVersion: string | null;
  generadoPor: string;
  generadoEn: string;
}

/** Fase 9 -- espejo en memoria de una fila `rentas.messaging_outbox`, mismo shape que
 *  `hoteles.messaging_outbox` (particiona por `propertyId`, ver migrations/011). */
interface StoredMessagingOutboxRow {
  id: string;
  propertyId: string;
  organizationId: string;
  channel: MessagingOutboxChannel;
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
}

interface StoredPayout {
  id: string;
  propertyId: string;
  canalId: string;
  canalCodigo: string;
  moneda: string;
  montoTotalCentavos: number;
  fechaPayout: string;
  referenciaExterna: string | null;
  lineas: LineaConciliada[];
  creadoEn: string;
}

function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function mismoPeriodo(a: RangoFechas, b: RangoFechas): boolean {
  return a.inicio === b.inicio && a.fin === b.fin;
}

function resumenDeLineas(lineas: readonly LineaConciliada[]): ResumenConciliacion {
  return {
    conciliadas: lineas.filter((l) => l.estado === "conciliado").length,
    pendientes: lineas.filter((l) => l.estado === "pendiente").length,
    discrepancias: lineas.filter((l) => l.estado === "discrepancia").length,
  };
}

// r5 -- mismos límites que el CHECK de `rentas.audit_log` (ver
// migrations/021_rentas_audit_log.sql) -- ver el comentario dentro de
// `registrarAuditoria` de abajo.
const AUDIT_LOG_CAMPO_MAX = 200;
const AUDIT_LOG_TEXTO_MAX = 500;

function truncarCampoAuditoria(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export class InMemoryRentasRepository implements RentasRepository {
  private readonly reglasCanalPricing = new Map<string, ReglaCanal>(); // key: unidadId:canalCodigo (usado por loadReglaCanalPricing)
  private readonly reglasComisionCanal: StoredReglaComisionCanal[] = [];
  private readonly reservasFinancieroPorOcupacion = new Map<string, StoredReservaFinanciero>();

  // ---- Pricing CRUD (Fase 2) — tablas granulares, mismo shape que migrations/002 ----
  private readonly tarifaBase = new Map<string, Map<string, StoredTarifaBase>>(); // unidadId -> vigenteDesde -> fila
  private readonly temporadas = new Map<string, StoredTemporada[]>(); // unidadId -> filas
  private readonly descuentosDuracion = new Map<string, Map<number, StoredDescuentoDuracion>>(); // unidadId -> nochesMinimas -> fila
  private readonly reglasMinStay = new Map<string, StoredReglaMinStay[]>(); // unidadId -> filas
  private readonly reglasCanalWrite = new Map<string, StoredReglaCanalPricing>(); // key: unidadId:canalId

  // ---- Owner statement / payout (Fase 2) ----
  private readonly owners = new Map<string, OwnerRecord>();
  private readonly ownerStatements: StoredOwnerStatement[] = [];
  private readonly payouts = new Map<string, StoredPayout>();

  // ---- Correo transaccional al huésped (Fase 9) ----
  /** `organization.name` -- no vive en el calendar store (no es un concepto de
   *  calendario), mismo criterio que `domain-citas::InMemoryCitasRepository.
   *  organizations`. */
  private readonly organizaciones = new Map<string, { name: string }>();
  private readonly messagingOutbox = new Map<string, StoredMessagingOutboxRow>();

  // ---- Fase 12 — descubrimiento de organización/property (panel web de staff) ----
  /** Espejo de solo-lectura de `core.organization` (vertical 'rentas') — mismo rol
   *  que `InMemoryHotelesRepository.organizations`. Deliberadamente separado de
   *  `organizaciones` de arriba (Fase 9, solo guarda `name` por id, insumo del
   *  correo transaccional): esta fila necesita también `slug`, que Fase 9 nunca
   *  necesitó. */
  private readonly organizationsDiscovery = new Map<string, RentasOrganizationSummary>();
  /** Espejo de solo-lectura de `core.property` (vertical 'rentas') — mismo rol que
   *  `InMemoryHotelesRepository.properties`. */
  private readonly propertiesDiscovery = new Map<string, RentasPropertySummary & { organizationId: string }>();

  // ---- r5 — bitácora de auditoría del staff ----
  /** Expuesto también como referencia tipada directa (`ctx.rentasRepo.auditLog`,
   *  mismo criterio que el resto de este archivo) para que un test pueda inspeccionar
   *  lo que quedó registrado sin depender de `listAuditoria`. */
  readonly auditLog: (RentasAuditLogRow & { readonly organizationId: string })[] = [];

  constructor(private readonly calendarStore: InMemoryRentasCalendarStore = new InMemoryRentasCalendarStore()) {}

  // ---- seeding ----

  seedUnidad(unidad: UnidadRecord): void {
    this.calendarStore.seedUnidad(unidad);
  }

  /** Fase 17 -- siembra una tarea operativa (+ checklist) para tests de
   *  apps/api/.../rentas/limpieza.ts -- ver el comentario de cabecera de
   *  `InMemoryRentasCalendarStore.seedTareaOperativa`. */
  seedTareaOperativa(input: Parameters<InMemoryRentasCalendarStore["seedTareaOperativa"]>[0]): ReturnType<InMemoryRentasCalendarStore["seedTareaOperativa"]> {
    return this.calendarStore.seedTareaOperativa(input);
  }

  /** Fase 17 -- siembra un ítem de inventario de una unidad para tests -- ver el
   *  comentario de cabecera de `InMemoryRentasCalendarStore.seedItemInventario`. */
  seedItemInventario(input: Parameters<InMemoryRentasCalendarStore["seedItemInventario"]>[0]): ReturnType<InMemoryRentasCalendarStore["seedItemInventario"]> {
    return this.calendarStore.seedItemInventario(input);
  }

  seedOwner(owner: OwnerRecord): void {
    this.owners.set(owner.id, owner);
  }

  /** Fase 9 -- nombre del tenant para el correo transaccional (`tenantNombre`, ver
   *  findOcupacionParaCorreo). Sin seed, cae a "atiende" (nunca lanza). */
  seedOrganizacion(organizationId: string, name: string): void {
    this.organizaciones.set(organizationId, { name });
  }

  /** Fase 12 -- siembra el espejo de `core.organization` que necesita
   *  `findOrganizationBySlug` (descubrimiento del panel web de staff). Separado de
   *  `seedOrganizacion` arriba a propósito (ver comentario de cabecera de
   *  `organizationsDiscovery`). */
  seedOrganization(organization: RentasOrganizationSummary): void {
    this.organizationsDiscovery.set(organization.id, organization);
  }

  /** Fase 12 -- siembra el espejo de `core.property` que necesita
   *  `listPropertiesForOrganization` (descubrimiento del panel web de staff). */
  seedPropertySummary(organizationId: string, property: RentasPropertySummary): void {
    this.propertiesDiscovery.set(property.propertyId, { ...property, organizationId });
  }

  /** Solo para tests -- inspecciona el outbox de correo encolado (mismo rol que
   *  `domain-citas::InMemoryCitasRepository.getOutbox`). */
  getMessagingOutbox(): readonly StoredMessagingOutboxRow[] {
    return [...this.messagingOutbox.values()];
  }

  /** Compatibilidad con la fixture de Fase 1 (`rentas-fixtures.ts`): descompone el
   *  `ContextoPricingUnidad` ya armado en las tablas granulares, con
   *  `vigenteDesde` deliberadamente muy en el pasado -- así una escritura real de
   *  Fase 2 (vigente_desde = hoy por defecto) siempre gana como "la más reciente
   *  vigente", igual que en Postgres real (`order by vigente_desde desc limit 1`). */
  seedPricingContext(unidadId: string, contexto: ContextoPricingUnidad): void {
    const vigenteDesdeSemilla = "2000-01-01";
    const porUnidad = this.tarifaBase.get(unidadId) ?? new Map<string, StoredTarifaBase>();
    porUnidad.set(vigenteDesdeSemilla, { id: randomUUID(), precioNocheCentavos: contexto.precioBaseNocheCentavos, moneda: contexto.moneda, vigenteDesde: vigenteDesdeSemilla });
    this.tarifaBase.set(unidadId, porUnidad);

    this.temporadas.set(
      unidadId,
      contexto.temporadas.map((t) => ({ id: randomUUID(), nombre: t.nombre, rango: t.rango, precioNocheCentavos: t.precioNocheCentavos, moneda: contexto.moneda })),
    );

    const descuentos = new Map<number, StoredDescuentoDuracion>();
    for (const d of contexto.descuentosDuracion) {
      descuentos.set(d.nochesMinimas, { id: randomUUID(), nochesMinimas: d.nochesMinimas, porcentajeDescuentoBasisPoints: d.porcentajeDescuentoBasisPoints, fuente: d.fuente });
    }
    this.descuentosDuracion.set(unidadId, descuentos);

    this.reglasMinStay.set(
      unidadId,
      contexto.reglasMinStay.map((r) => ({ id: randomUUID(), rango: r.rango, diaSemanaCheckIn: r.diaSemanaCheckIn, nochesMinimas: r.nochesMinimas })),
    );
  }

  seedReglaCanalPricing(unidadId: string, canalCodigo: string, regla: ReglaCanal): void {
    this.reglasCanalPricing.set(`${unidadId}:${canalCodigo}`, regla);
  }

  seedReglaComisionCanal(input: { propertyId: string | null; canalId: string | null; config: ConfiguracionComisionCanal }): void {
    this.reglasComisionCanal.push(input);
  }

  // ---- RentasRepository: calendario (delegado al store compartido) ----

  async findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null> {
    return this.calendarStore.findUnidad(propertyId, unidadId);
  }

  async findCanalPorCodigo(codigo: string): Promise<CanalRecord | null> {
    return this.calendarStore.findCanalPorCodigo(codigo);
  }

  async findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): Promise<OcupacionResumen | null> {
    return this.calendarStore.findOcupacion(propertyId, unidadId, ocupacionId);
  }

  async insertGuestMinimo(input: NewGuestMinimoInput): Promise<{ id: string }> {
    return this.calendarStore.insertGuestMinimo(input);
  }

  async attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): Promise<void> {
    this.calendarStore.attachGuestToOcupacion(ocupacionId, guestMinimoId);
  }

  async listBloqueos(propertyId: string, unidadId: string): Promise<readonly BloqueoRecord[]> {
    return this.calendarStore.listBloqueos(propertyId, unidadId);
  }

  // ---- RentasRepository: calendario visual del panel de staff (Fase 13, delegado al
  // store compartido -- mismo criterio que el resto de este bloque) ----

  async listUnidades(propertyId: string): Promise<readonly UnidadRecord[]> {
    return this.calendarStore.listUnidades(propertyId);
  }

  async listOcupaciones(propertyId: string, unidadId: string): Promise<readonly OcupacionCalendarioItem[]> {
    return this.calendarStore.listOcupaciones(propertyId, unidadId);
  }

  async listOcupacionesPage(propertyId: string, unidadId: string, opts: { readonly limit: number; readonly offset: number }): Promise<OcupacionCalendarioPage> {
    const filtered = this.calendarStore.listOcupaciones(propertyId, unidadId);
    const items = filtered.slice(opts.offset, opts.offset + opts.limit);
    const nextOffset = opts.offset + items.length < filtered.length ? opts.offset + items.length : null;
    return { items, total: filtered.length, nextOffset };
  }

  // ---- RentasRepository: Fase 17 -- panel operativo del rol `limpieza` (delegado al
  // store compartido -- mismo criterio que el resto de este bloque: las escrituras
  // reales de este módulo las hace `InMemoryRentasTenancyEngine` sobre la MISMA
  // instancia, ver el comentario de cabecera de calendar-store.ts) ----

  async listTareas(propertyId: string, filtro?: TareaListFiltro): Promise<readonly TareaOperativaRecord[]> {
    return this.calendarStore.listTareas(propertyId, filtro);
  }

  async findTareaDetalle(propertyId: string, tareaId: string): Promise<TareaOperativaDetalle | null> {
    return this.calendarStore.findTareaDetalle(propertyId, tareaId);
  }

  async findChecklistItem(propertyId: string, tareaId: string, itemId: string): Promise<{ id: string } | null> {
    return this.calendarStore.findChecklistItem(propertyId, tareaId, itemId);
  }

  async listItemsInventario(propertyId: string, unidadId: string): Promise<readonly ItemInventarioRecord[]> {
    return this.calendarStore.listItemsInventario(propertyId, unidadId);
  }

  async listIncidencias(propertyId: string, unidadId: string): Promise<readonly IncidenciaMantenimientoRecord[]> {
    return this.calendarStore.listIncidencias(propertyId, unidadId);
  }

  // ---- RentasRepository: pricing (lectura, flujo 2 Fase 1) ----

  async loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null> {
    const unidad = this.calendarStore.findUnidad(propertyId, unidadId);
    if (!unidad) return null;

    const hoy = hoyIso();
    const bases = [...(this.tarifaBase.get(unidadId)?.values() ?? [])].filter((b) => b.vigenteDesde <= hoy);
    if (bases.length === 0) return null;
    const vigente = bases.sort((a, b) => (a.vigenteDesde < b.vigenteDesde ? 1 : a.vigenteDesde > b.vigenteDesde ? -1 : 0))[0]!;

    return {
      unidadId,
      moneda: vigente.moneda,
      precioBaseNocheCentavos: vigente.precioNocheCentavos,
      temporadas: (this.temporadas.get(unidadId) ?? []).map((t) => ({ nombre: t.nombre, rango: t.rango, precioNocheCentavos: t.precioNocheCentavos })),
      descuentosDuracion: [...(this.descuentosDuracion.get(unidadId)?.values() ?? [])].map((d) => ({ nochesMinimas: d.nochesMinimas, porcentajeDescuentoBasisPoints: d.porcentajeDescuentoBasisPoints, fuente: d.fuente })),
      reglasMinStay: (this.reglasMinStay.get(unidadId) ?? []).map((r) => ({ rango: r.rango, diaSemanaCheckIn: r.diaSemanaCheckIn, nochesMinimas: r.nochesMinimas })),
    };
  }

  async loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null> {
    return this.reglasCanalPricing.get(`${unidadId}:${canalCodigo}`) ?? null;
  }

  // ---- RentasRepository: pricing CRUD (flujo 4, Fase 2) ----

  async findMonedaExistentePricing(unidadId: string, excluirVigenteDesde?: string): Promise<string | null> {
    const bases = [...(this.tarifaBase.get(unidadId)?.values() ?? [])].filter((b) => b.vigenteDesde !== excluirVigenteDesde);
    if (bases[0]) return bases[0].moneda;
    const temporadas = this.temporadas.get(unidadId) ?? [];
    if (temporadas[0]) return temporadas[0].moneda;
    return null;
  }

  async upsertTarifaBase(input: NewTarifaBaseInput): Promise<{ id: string }> {
    const porUnidad = this.tarifaBase.get(input.unidadId) ?? new Map<string, StoredTarifaBase>();
    const existente = porUnidad.get(input.vigenteDesde);
    const id = existente?.id ?? randomUUID();
    porUnidad.set(input.vigenteDesde, { id, precioNocheCentavos: input.precioNocheCentavos, moneda: input.moneda, vigenteDesde: input.vigenteDesde });
    this.tarifaBase.set(input.unidadId, porUnidad);
    return { id };
  }

  async listTemporadas(unidadId: string): Promise<TemporadaRecord[]> {
    return (this.temporadas.get(unidadId) ?? []).map((t) => ({ id: t.id, nombre: t.nombre, rango: t.rango, precioNocheCentavos: t.precioNocheCentavos }));
  }

  async insertTemporada(input: NewTemporadaInput): Promise<{ id: string }> {
    const id = randomUUID();
    const lista = this.temporadas.get(input.unidadId) ?? [];
    lista.push({ id, nombre: input.nombre, rango: input.rango, precioNocheCentavos: input.precioNocheCentavos, moneda: input.moneda });
    this.temporadas.set(input.unidadId, lista);
    return { id };
  }

  async listDescuentosDuracion(unidadId: string): Promise<DescuentoDuracionRecord[]> {
    return [...(this.descuentosDuracion.get(unidadId)?.values() ?? [])].map((d) => ({ id: d.id, nochesMinimas: d.nochesMinimas, porcentajeDescuentoBasisPoints: d.porcentajeDescuentoBasisPoints, fuente: d.fuente }));
  }

  async upsertDescuentoDuracion(input: NewDescuentoDuracionInput): Promise<{ id: string }> {
    const porUnidad = this.descuentosDuracion.get(input.unidadId) ?? new Map<number, StoredDescuentoDuracion>();
    const existente = porUnidad.get(input.nochesMinimas);
    const id = existente?.id ?? randomUUID();
    porUnidad.set(input.nochesMinimas, { id, nochesMinimas: input.nochesMinimas, porcentajeDescuentoBasisPoints: input.porcentajeDescuentoBasisPoints, fuente: input.fuente });
    this.descuentosDuracion.set(input.unidadId, porUnidad);
    return { id };
  }

  async listReglasMinStay(unidadId: string): Promise<ReglaMinStayRecord[]> {
    return (this.reglasMinStay.get(unidadId) ?? []).map((r) => ({ id: r.id, rango: r.rango, diaSemanaCheckIn: r.diaSemanaCheckIn, nochesMinimas: r.nochesMinimas }));
  }

  async insertReglaMinStay(input: NewReglaMinStayInput): Promise<{ id: string }> {
    const id = randomUUID();
    const lista = this.reglasMinStay.get(input.unidadId) ?? [];
    lista.push({ id, rango: input.rango, diaSemanaCheckIn: input.diaSemanaCheckIn, nochesMinimas: input.nochesMinimas });
    this.reglasMinStay.set(input.unidadId, lista);
    return { id };
  }

  async upsertReglaCanalPricing(input: NewReglaCanalPricingInput): Promise<{ id: string }> {
    const key = `${input.unidadId}:${input.canalId}`;
    const existente = this.reglasCanalWrite.get(key);
    const id = existente?.id ?? randomUUID();
    this.reglasCanalWrite.set(key, { id, canalId: input.canalId, markupBasisPoints: input.markupBasisPoints, activo: input.activo });

    // Mantiene sincronizado el mapa de LECTURA (keyed por código, usado por
    // cotizaciones.ts) — en Postgres real ambos caminos leen la misma tabla
    // `tarifa_regla_canal`, aquí se refleja el mismo efecto manualmente.
    const canal = [...this.calendarStore.canales.entries()].find(([, c]) => c.id === input.canalId);
    if (canal) {
      const [codigo] = canal;
      this.reglasCanalPricing.set(`${input.unidadId}:${codigo}`, { canalCodigo: codigo, markupBasisPoints: input.markupBasisPoints, activo: input.activo });
    }
    return { id };
  }

  // ---- RentasRepository: owner statement (flujo 5, Fase 2) ----

  async findOwnerConUnidadesEnProperty(propertyId: string, ownerId: string): Promise<OwnerRecord | null> {
    const owner = this.owners.get(ownerId);
    if (!owner) return null;
    const tieneUnidad = [...this.calendarStore.unidades.values()].some((u) => u.propertyId === propertyId && u.ownerId === ownerId);
    return tieneUnidad ? owner : null;
  }

  async findMovimientosPeriodoParaOwner(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<ReservaParaStatement[]> {
    const resultado: ReservaParaStatement[] = [];
    for (const fila of this.reservasFinancieroPorOcupacion.values()) {
      if (fila.propertyId !== propertyId) continue;
      const ocupacion = this.calendarStore.getOcupacion(fila.ocupacionId);
      if (!ocupacion || ocupacion.estado === "cancelado") continue;
      const unidad = [...this.calendarStore.unidades.values()].find((u) => u.id === ocupacion.unidadId);
      if (!unidad || unidad.ownerId !== ownerId) continue;
      // Mismo criterio que el origen: el checkout (`upper(rango)`) cae dentro del
      // periodo `[periodoInicio, periodoFin)`.
      if (!(ocupacion.fin >= periodo.inicio && ocupacion.fin < periodo.fin)) continue;
      resultado.push({
        ocupacionId: fila.ocupacionId,
        moneda: fila.movimiento.moneda,
        ingresoBrutoCentavos: fila.movimiento.ingresoBrutoCentavos,
        comisionCanalCentavos: fila.movimiento.comisionCanalCentavos,
        comisionGestorCentavos: fila.movimiento.comisionGestorCentavos,
        gastosCentavos: fila.movimiento.gastosCentavos,
        impuestosCentavos: fila.movimiento.impuestosCentavos,
        netoCentavos: fila.movimiento.netoCentavos,
      });
    }
    return resultado;
  }

  async findUltimaVersionOwnerStatement(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<UltimaVersionOwnerStatement | null> {
    const candidatas = this.ownerStatements.filter((s) => s.propertyId === propertyId && s.ownerId === ownerId && mismoPeriodo(s.periodo, periodo));
    if (candidatas.length === 0) return null;
    const ultima = candidatas.sort((a, b) => b.version - a.version)[0]!;
    return { id: ultima.id, version: ultima.version, hashContenido: ultima.hashContenido };
  }

  async insertOwnerStatement(input: NewOwnerStatementInput): Promise<{ id: string; generadoEn: string }> {
    const yaExiste = this.ownerStatements.some((s) => s.propertyId === input.propertyId && s.ownerId === input.ownerId && mismoPeriodo(s.periodo, input.periodo) && s.version === input.version);
    if (yaExiste) {
      throw new Error(`owner_statement_owner_id_property_id_periodo_inicio_periodo_fin_version_key: ya existe la versión ${input.version} para este owner/periodo.`);
    }
    const id = randomUUID();
    const generadoEn = new Date().toISOString();
    this.ownerStatements.push({
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      ownerId: input.ownerId,
      periodo: input.periodo,
      version: input.version,
      moneda: input.moneda,
      totales: input.totales,
      lineas: [...input.lineas],
      hashContenido: input.hashContenido,
      motivoVersion: input.motivoVersion,
      generadoPor: input.generadoPor,
      generadoEn,
    });
    return { id, generadoEn };
  }

  async listOwnerStatements(propertyId: string, ownerId: string): Promise<OwnerStatementSummary[]> {
    const propios = this.ownerStatements.filter((s) => s.propertyId === propertyId && s.ownerId === ownerId);
    const ultimaPorPeriodo = new Map<string, StoredOwnerStatement>();
    for (const s of propios) {
      const key = `${s.periodo.inicio}:${s.periodo.fin}`;
      const actual = ultimaPorPeriodo.get(key);
      if (!actual || s.version > actual.version) ultimaPorPeriodo.set(key, s);
    }
    return [...ultimaPorPeriodo.values()]
      .sort((a, b) => (a.periodo.inicio < b.periodo.inicio ? 1 : a.periodo.inicio > b.periodo.inicio ? -1 : 0))
      .map((s) => ({ id: s.id, ownerId: s.ownerId, propertyId: s.propertyId, periodo: s.periodo, version: s.version, moneda: s.moneda, netoCentavos: s.totales.netoCentavos, generadoEn: s.generadoEn }));
  }

  async findOwnerStatementDetalle(propertyId: string, statementId: string): Promise<OwnerStatementDetalle | null> {
    const s = this.ownerStatements.find((x) => x.id === statementId && x.propertyId === propertyId);
    if (!s) return null;
    return {
      id: s.id,
      ownerId: s.ownerId,
      propertyId: s.propertyId,
      periodo: s.periodo,
      version: s.version,
      moneda: s.moneda,
      netoCentavos: s.totales.netoCentavos,
      generadoEn: s.generadoEn,
      totales: s.totales,
      lineas: s.lineas,
      motivoVersion: s.motivoVersion,
    };
  }

  // ---- RentasRepository: payout / conciliación (flujo 6, Fase 2) ----

  async findCandidatasConciliacion(propertyId: string, canalId: string): Promise<CandidataConciliacion[]> {
    const resultado: CandidataConciliacion[] = [];
    for (const fila of this.reservasFinancieroPorOcupacion.values()) {
      if (fila.propertyId !== propertyId) continue;
      const ocupacion = this.calendarStore.getOcupacion(fila.ocupacionId);
      if (!ocupacion || ocupacion.canalOrigenId !== canalId) continue;
      resultado.push({ ocupacionId: fila.ocupacionId, externalId: ocupacion.externalId, montoEsperadoCentavos: fila.movimiento.montoRecibidoCentavos });
    }
    return resultado;
  }

  async insertPayout(input: NewPayoutInput): Promise<{ id: string; creadoEn: string }> {
    const id = randomUUID();
    const creadoEn = new Date().toISOString();
    const canal = [...this.calendarStore.canales.entries()].find(([, c]) => c.id === input.canalId);
    this.payouts.set(id, {
      id,
      propertyId: input.propertyId,
      canalId: input.canalId,
      canalCodigo: canal?.[0] ?? "desconocido",
      moneda: input.moneda,
      montoTotalCentavos: input.montoTotalCentavos,
      fechaPayout: input.fechaPayout,
      referenciaExterna: input.referenciaExterna,
      lineas: [...input.lineas],
      creadoEn,
    });
    return { id, creadoEn };
  }

  async findPayoutDetalle(propertyId: string, payoutId: string): Promise<PayoutDetalle | null> {
    const p = this.payouts.get(payoutId);
    if (!p || p.propertyId !== propertyId) return null;
    return {
      id: p.id,
      propertyId: p.propertyId,
      canalCodigo: p.canalCodigo,
      moneda: p.moneda,
      montoTotalCentavos: p.montoTotalCentavos,
      fechaPayout: p.fechaPayout,
      referenciaExterna: p.referenciaExterna,
      resumen: resumenDeLineas(p.lineas),
      lineas: p.lineas,
    };
  }

  // ---- RentasRepository: finanzas (flujo 3, Fase 1) ----

  async findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null> {
    return this.calendarStore.findOcupacionParaMovimiento(propertyId, ocupacionId);
  }

  async findReglaComisionCanal(propertyId: string, canalId: string | null): Promise<ConfiguracionComisionCanal> {
    // Mismo orden de búsqueda que `buscarReglaComisionCanal` del origen: primero una
    // regla específica de esta property, luego la regla global del tenant
    // (property_id IS NULL) — fail-closed si no hay ninguna configurada.
    const especifica = this.reglasComisionCanal.find((r) => r.propertyId === propertyId && r.canalId === canalId);
    if (especifica) return especifica.config;
    const global = this.reglasComisionCanal.find((r) => r.propertyId === null && r.canalId === canalId);
    if (global) return global.config;
    throw new Error(`No hay rentas.regla_comision_canal configurada para canalId="${canalId}" (ni específica de la property ni global del tenant).`);
  }

  async insertReservaFinanciero(input: NewReservaFinancieroInput): Promise<{ id: string; createdAt: string }> {
    const existente = this.reservasFinancieroPorOcupacion.get(input.ocupacionId);
    if (existente) {
      throw new Error(`reserva_financiero_ocupacion_unidad_id_key: ya existe un movimiento financiero para la ocupación ${input.ocupacionId}.`);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const movimiento: MovimientoFinancieroReserva = {
      ocupacionUnidadId: input.ocupacionId,
      moneda: input.moneda,
      ingresoBrutoCentavos: input.montoBrutoCentavos,
      montoRecibidoCentavos: input.montoRecibidoCentavos,
      comisionCanalCentavos: input.comisionCanalCentavos,
      comisionCanalFuente: input.comisionCanalFuente,
      comisionGestorCentavos: input.comisionGestorCentavos,
      gastosCentavos: input.gastosCentavos,
      impuestosCentavos: input.impuestosCentavos,
      netoCentavos: input.netoCentavos,
    };
    this.reservasFinancieroPorOcupacion.set(input.ocupacionId, { id, organizationId: input.organizationId, propertyId: input.propertyId, ocupacionId: input.ocupacionId, createdAt, movimiento });
    return { id, createdAt };
  }

  async findReservaFinanciero(propertyId: string, ocupacionId: string): Promise<MovimientoFinancieroReserva | null> {
    const fila = this.reservasFinancieroPorOcupacion.get(ocupacionId);
    if (!fila || fila.propertyId !== propertyId) return null;
    return fila.movimiento;
  }

  // ---- RentasRepository: correo transaccional al huésped (Fase 9) ----

  async findOcupacionParaCorreo(organizationId: string, ocupacionId: string): Promise<OcupacionParaCorreo | null> {
    const datos = this.calendarStore.findOcupacionParaCorreoDatos(organizationId, ocupacionId);
    if (!datos) return null;
    return { ...datos, tenantNombre: this.organizaciones.get(organizationId)?.name ?? "atiende" };
  }

  async listReservasProximasACheckIn(desdeFecha: string, hastaFecha: string): Promise<readonly ReservaProximaCheckIn[]> {
    return this.calendarStore.listReservasProximasACheckIn(desdeFecha, hastaFecha).map((r) => ({ ocupacionId: r.id, organizationId: r.organizationId }));
  }

  async marcarRecordatorioCheckInEnviado(ocupacionId: string, enviadoEnIso: string): Promise<void> {
    this.calendarStore.marcarRecordatorioCheckInEnviado(ocupacionId, enviadoEnIso);
  }

  async enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: MessagingOutboxChannel, eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    const existente = [...this.messagingOutbox.values()].find((o) => o.propertyId === propertyId && o.channel === channel && o.dedupeKey === dedupeKey);
    if (existente) {
      // Mismo criterio que `rentas.enqueue_messaging_outbox` real: un reintento sobre
      // una fila ya 'sent'/'processing'/'dead' nunca pisa el payload -- solo
      // 'pending'/'failed' se actualizan.
      if (existente.status === "pending" || existente.status === "failed") {
        existente.payload = payload;
        existente.eventType = eventType;
      }
      return;
    }
    const id = randomUUID();
    this.messagingOutbox.set(id, { id, propertyId, organizationId, channel, eventType, dedupeKey, payload, status: "pending", attempts: 0 });
  }

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const claimable = [...this.messagingOutbox.values()].filter((o) => o.channel === "email" && (o.status === "pending" || o.status === "failed") && o.attempts < 5).slice(0, limit);
    for (const job of claimable) {
      job.status = "processing";
      job.attempts += 1;
    }
    return claimable.map((o) => ({ id: o.id, propertyId: o.propertyId, organizationId: o.organizationId, attempts: o.attempts, payload: (o.payload ?? {}) as Record<string, unknown> }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", _error: string | null): Promise<void> {
    const job = this.messagingOutbox.get(id);
    if (!job || job.channel !== "email") return;
    job.status = status;
  }

  // ---- RentasRepository: Fase 12 — descubrimiento de organización/property ----

  async findOrganizationBySlug(slug: string): Promise<RentasOrganizationSummary | null> {
    for (const org of this.organizationsDiscovery.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly RentasPropertySummary[]> {
    return [...this.propertiesDiscovery.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p) => ({ propertyId: p.propertyId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- RentasRepository: r5 — bitácora de auditoría del staff ----

  async registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void> {
    // A diferencia de PostgresRentasRepository (que ignora `input.actorUserId` y deja
    // que `rentas.record_audit_log` capture el actor real vía `auth.uid()`), este
    // doble en memoria SÍ lo usa -- no hay sesión SQL/`auth.uid()` que simular aquí,
    // y los tests necesitan un actor real para poder afirmar "quién" quedó registrado.
    this.auditLog.push({
      id: randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      // Trunca a los MISMOS límites que el CHECK de `rentas.audit_log`
      // (200/500/500, ver migrations/021_rentas_audit_log.sql) -- mismo criterio
      // que `left(..., N)` dentro de `rentas.record_audit_log`. Sin este truncamiento
      // este doble en memoria no reproduce el bug real que ese `left()` corrige (un
      // `motivoVersion` largo violando el CHECK contra Postgres real), así que
      // ningún test que solo use este repositorio lo detectaría (hallazgo de
      // revisión r5: bloqueante 1).
      campo: truncarCampoAuditoria(input.campo, AUDIT_LOG_CAMPO_MAX),
      antes: truncarCampoAuditoria(input.antes, AUDIT_LOG_TEXTO_MAX),
      despues: truncarCampoAuditoria(input.despues, AUDIT_LOG_TEXTO_MAX),
      createdAtMs: Date.now(),
    });
  }

  async listAuditoria(organizationId: string, filtro: RentasAuditLogFiltro, paginacion: RentasAuditLogPaginacion): Promise<RentasAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    let filtrados = this.auditLog.filter((r) => r.organizationId === organizationId);
    if (filtro.entityType) filtrados = filtrados.filter((r) => r.entityType === filtro.entityType);
    if (filtro.desde) {
      const desdeMs = new Date(`${filtro.desde}T00:00:00.000Z`).getTime();
      filtrados = filtrados.filter((r) => r.createdAtMs >= desdeMs);
    }
    if (filtro.hasta) {
      const hastaExclusivoMs = new Date(`${filtro.hasta}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
      filtrados = filtrados.filter((r) => r.createdAtMs < hastaExclusivoMs);
    }
    filtrados = [...filtrados].sort((a, b) => b.createdAtMs - a.createdAtMs);

    const total = filtrados.length;
    const pagina = filtrados.slice(offset, offset + limit).map(({ organizationId: _organizationId, ...row }) => row);
    return { disponible: true, items: pagina, total, nextOffset: offset + pagina.length < total ? offset + pagina.length : null };
  }
}
