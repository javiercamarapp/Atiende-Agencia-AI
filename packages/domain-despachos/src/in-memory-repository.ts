// InMemoryDespachosRepository — implementación real (no un mock) de
// `DespachosRepository`, con las mismas restricciones de integridad que las
// migraciones SQL de migrations/001 (folio_fiscal único por organización). Sirve
// para tests determinísticos y como fallback dev/CI sin Postgres real — mismo rol
// que InMemoryHotelesRepository/InMemoryRestaurantesRepository.
import { randomUUID } from "node:crypto";
import { EstadoSatInvalidoError, InvoiceAlreadyExistsError, InvoiceNoEncontradoError, InvoiceReviewAlreadyResolvedError, ReceivableAlreadyExistsError, ReceivableAlreadyPaidError } from "./errors.ts";
import { EFOS_NO_DISPONIBLE } from "./cfdi/efos.ts";
import { NOMBRE_IMPUESTO } from "./cfdi/modelo-cfdi.ts";
import type { DireccionCfdi, EstadoSatCfdi, ImpuestoCfdiRecord } from "./cfdi/modelo-cfdi.ts";
import type { EfosConsulta, EfosContribuyente } from "./cfdi/efos.ts";
import type { DespachosRepository, EfosAfectadosResultado, EfosEstadoLista, EfosIngestaResultado, EmailOutboxJobRow, InvoicePage, OrganizationNotificationRecipient } from "./repository.ts";
import type {
  CollectionEventRecord,
  DeadlineEscalationRecord,
  DespachosAuditLogEntry,
  DespachosAuditLogPage,
  DespachosPropertyConfigRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewCollectionEventInput,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
  NewReceivableInput,
  NewSystemCollectionEventInput,
  ReceivableRecord,
  ReceivableReminderRow,
} from "./types.ts";
import type { NivelEscalamiento } from "./vencimientos/engine.ts";
import type { NuevoLoteEstadoCuenta, NuevoMovimientoEstadoCuenta, ResultadoGuardadoEstadoCuenta } from "./conciliacion/estado-de-cuenta/types.ts";
import type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
import { construirTareasDesdePlantilla } from "./cierre-mensual/engine.ts";
import type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";
import type { ClosePeriod, CloseTask } from "./cierre-mensual/types.ts";

export class InMemoryDespachosRepository implements DespachosRepository {
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly invoiceByOrgFolio = new Map<string, string>(); // key: organizationId:folioFiscal -> invoiceId
  private readonly impuestosPorInvoice = new Map<string, readonly ImpuestoCfdiRecord[]>();
  private readonly reviews = new Map<string, InvoiceReviewRecord>();
  private readonly deadlines = new Map<string, FiscalDeadlineRecord>();
  private readonly escalations = new Map<string, DeadlineEscalationRecord[]>(); // key: deadlineId
  private readonly mapeosMigracion = new Map<string, MapeoMigracionCuenta>();
  private readonly periodosCierre = new Map<string, ClosePeriod>();
  private readonly tareasCierre = new Map<string, CloseTask[]>(); // key: periodoId
  private readonly organizations = new Map<string, { id: string; name: string; slug: string; isActive: boolean }>();
  private readonly organizationIdBySlug = new Map<string, string>();
  private readonly despachosProperties = new Map<string, { propertyId: string; organizationId: string; name: string }>();
  private readonly receivables = new Map<string, ReceivableRecord>();
  // FASE 3 (producto) -- zona horaria por negocio (migración 012), ver
  // `repository.ts::findPropertyConfig`/`upsertPropertyConfigZonaHoraria`.
  private readonly propertyConfigs = new Map<string, DespachosPropertyConfigRecord>();
  // D-04 (migración 014): ediciones de la lista 69-B por periodo.
  private readonly efosListas = new Map<string, { sha: string; filas: readonly EfosContribuyente[]; ingestadoEn: string }>();

  /** Espejo en memoria de `despachos.audit_log` -- f2-orden-total-bitacoras.
   * Expuesto directo (mismo criterio que `InMemoryRentasRepository.auditLog`, ver
   * PR #173) para que un test pueda sembrar filas sin pasar por ninguna ruta HTTP
   * (que hoy no existe -- la escritura real de producción es
   * `ProductionDespachosAuditSink`, fuera de `DespachosRepository`; ver el
   * comentario de cabecera de `listAuditLogPage` en `repository.ts`). `seq` es el
   * desempate monótono EQUIVALENTE a la columna `seq bigint generated always as
   * identity` de Postgres (migración 011): `Date.now()` (`createdAtMs`) tiene
   * resolución de milisegundo, así que dos filas sembradas en el mismo milisegundo
   * (exactamente lo que reproduce un reloj falso congelado en tests) empatan sin
   * este desempate. */
  readonly auditLog: (DespachosAuditLogEntry & { readonly organizationId: string; readonly createdAtMs: number; readonly seq: number })[] = [];
  private auditLogSeq = 0;

  /** Siembra una fila para pruebas -- ver el comentario de `auditLog` arriba. */
  registrarAuditLogParaPruebas(input: { readonly organizationId: string; readonly actorUserId: string | null; readonly action: string; readonly payload?: Record<string, unknown> }): void {
    this.auditLogSeq += 1;
    const createdAtMs = Date.now();
    this.auditLog.push({
      id: randomUUID(),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      payload: input.payload ?? {},
      createdAtMs,
      createdAt: new Date(createdAtMs).toISOString(),
      seq: this.auditLogSeq,
    });
  }

  async listAuditLogPage(organizationId: string, opts: { readonly limit: number; readonly offset: number }): Promise<DespachosAuditLogPage> {
    const { limit, offset } = opts;
    // f2-orden-total-bitacoras -- desempate por `seq` cuando `createdAtMs` empata
    // (ver el comentario de `auditLog` arriba) -- MISMO orden que
    // `PostgresDespachosRepository.listAuditLogPage` (`order by created_at desc,
    // seq desc`). `Array.prototype.sort` es estable: sin este desempate, dos filas
    // del mismo milisegundo quedarían en orden de inserción (más antigua primero),
    // exactamente al revés de "más reciente primero".
    const filtrados = this.auditLog
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.seq - a.seq);
    const total = filtrados.length;
    const pagina = filtrados.slice(offset, offset + limit).map(({ organizationId: _organizationId, createdAtMs: _createdAtMs, seq: _seq, ...row }) => row);
    return { items: pagina, total, nextOffset: offset + pagina.length < total ? offset + pagina.length : null };
  }
  private readonly receivableByInvoice = new Map<string, string>(); // key: invoiceId -> receivableId
  private readonly collectionEvents = new Map<string, CollectionEventRecord[]>(); // key: receivableId

  /** Contadores de llamadas a los métodos BATCH de cobranza -- expuestos para que los
   * tests de rendimiento (ver apps/api/tests/despachos-cobranza.spec.ts) verifiquen
   * que GET .../cobranza/cuentas y GET .../cobranza/resumen ejecutan un número de
   * llamadas al repositorio FIJO, sin importar cuántas cuentas por cobrar tenga la
   * cartera (hallazgo de auditoría, rubro 10 "performance y escalabilidad": "cobranza
   * de despachos con 1+2N queries serializadas"). No forman parte del contrato
   * `DespachosRepository`. */
  llamadasFindInvoicesByIds = 0;
  llamadasListCollectionEventsForReceivables = 0;

  // ---- Infraestructura de correo (migración 005) ----
  private readonly notificationRecipients = new Map<string, OrganizationNotificationRecipient[]>(); // orgId -> staff owner/admin
  private readonly messagingOutbox = new Map<
    string,
    { id: string; organizationId: string; channel: "email"; eventType: string; dedupeKey: string; payload: Record<string, unknown>; status: "pending" | "processing" | "sent" | "failed" | "dead"; attempts: number; lastError: string | null; createdAt: string }
  >();
  private readonly messagingOutboxDedupe = new Map<string, string>(); // key: orgId:channel:dedupeKey -> outbox id

  // ---- Fase 9 — seeding (equivalente a INSERT manual contra las migraciones SQL),
  // mismo rol EXACTO que InMemoryLicitacionesRepository.seedOrganization/
  // seedLicitacionesProperty. ----

  seedOrganization(org: { id: string; slug: string; name: string; isActive?: boolean }): void {
    this.organizations.set(org.id, { id: org.id, name: org.name, slug: org.slug, isActive: org.isActive ?? true });
    this.organizationIdBySlug.set(org.slug, org.id);
  }

  seedDespachosProperty(property: { id: string; organizationId: string; name: string }): void {
    this.despachosProperties.set(property.id, { propertyId: property.id, organizationId: property.organizationId, name: property.name });
  }

  /** Migración 005 — equivalente en memoria de
   * `despachos.organization_notification_recipients` (staff `owner`/`admin` real vía
   * `core.membership`/`core.staff_user` en Postgres): este repositorio en memoria no
   * modela `core.*` (vive en `@atiende/db`, un paquete distinto), así que las pruebas
   * siembran aquí directamente a quién debe llegarle el correo de escalamiento --
   * mismo rol EXACTO que `InMemoryLicitacionesRepository.seedNotificationRecipient`.
   * Sin sembrar nada, la organización simplemente no tiene destinatarios (mismo
   * comportamiento honesto que una organización real sin ningún staff owner/admin
   * todavía). */
  seedNotificationRecipient(organizationId: string, recipient: OrganizationNotificationRecipient): void {
    const list = this.notificationRecipients.get(organizationId) ?? [];
    this.notificationRecipients.set(organizationId, [...list, recipient]);
  }

  /** Solo para pruebas -- inspecciona el outbox completo (mismo rol que
   * `InMemoryCitasRepository.getOutbox()`/`InMemoryLicitacionesRepository.getMessagingOutbox()`). */
  getMessagingOutbox(): readonly { id: string; organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: Record<string, unknown>; status: string; attempts: number; lastError: string | null }[] {
    return [...this.messagingOutbox.values()];
  }

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const id = this.organizationIdBySlug.get(slug);
    if (!id) return null;
    return this.organizations.get(id) ?? null;
  }

  async findOrganizationById(organizationId: string): Promise<{ readonly id: string; readonly name: string } | null> {
    const org = this.organizations.get(organizationId);
    return org ? { id: org.id, name: org.name } : null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    return [...this.despachosProperties.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p) => ({ propertyId: p.propertyId, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- CFDI ----

  async insertInvoice(input: NewInvoiceInput): Promise<InvoiceRecord> {
    const key = `${input.organizationId}:${input.folioFiscal}`;
    if (this.invoiceByOrgFolio.has(key)) {
      throw new InvoiceAlreadyExistsError(input.folioFiscal);
    }
    const id = randomUUID();
    // confianza: Fase 1 siempre null (sin evaluar confianza automática todavía — el
    // motor de confianza real es Fase 2, ver types.ts).
    const { impuestos, ...historico } = input;
    const record: InvoiceRecord = {
      id,
      createdAt: new Date().toISOString(),
      confianza: null,
      ...historico,
      direccion: input.direccion ?? null,
      metodoPago: input.metodoPago ?? null,
      formaPago: input.formaPago ?? null,
      usoCfdi: input.usoCfdi ?? null,
      moneda: input.moneda ?? null,
      tipoCambio: input.tipoCambio ?? null,
      subtotalCentavos: input.subtotalCentavos ?? null,
      descuentoCentavos: input.descuentoCentavos ?? null,
      totalCentavos: input.totalCentavos ?? null,
      ivaTrasladadoCentavos: input.ivaTrasladadoCentavos ?? null,
      isrRetenidoCentavos: input.isrRetenidoCentavos ?? null,
      ivaRetenidoCentavos: input.ivaRetenidoCentavos ?? null,
      iepsCentavos: input.iepsCentavos ?? null,
      estadoSat: "pendiente",
      estadoSatVerificadoEn: null,
    };
    this.impuestosPorInvoice.set(id, (impuestos ?? []).map((i) => ({ ...i, nombre: NOMBRE_IMPUESTO[i.impuesto] ?? i.impuesto })));
    this.invoices.set(id, record);
    this.invoiceByOrgFolio.set(key, id);
    return record;
  }

  async listarImpuestosInvoice(propertyId: string, invoiceId: string): Promise<readonly ImpuestoCfdiRecord[]> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) return [];
    return this.impuestosPorInvoice.get(invoiceId) ?? [];
  }

  async registrarEstadoSatInvoice(propertyId: string, invoiceId: string, estado: EstadoSatCfdi): Promise<void> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) throw new InvoiceNoEncontradoError();
    if (invoice.estadoSat === "cancelado" && estado !== "cancelado") throw new EstadoSatInvalidoError("un CFDI cancelado no cambia de estado");
    this.invoices.set(invoiceId, { ...invoice, estadoSat: estado, estadoSatVerificadoEn: new Date().toISOString() });
  }

  async findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) return null;
    return invoice;
  }

  async findInvoicesByIds(propertyId: string, invoiceIds: readonly string[]): Promise<readonly InvoiceRecord[]> {
    this.llamadasFindInvoicesByIds += 1;
    const idSet = new Set(invoiceIds);
    const resultado: InvoiceRecord[] = [];
    for (const invoice of this.invoices.values()) {
      if (invoice.propertyId === propertyId && idSet.has(invoice.id)) resultado.push(invoice);
    }
    return resultado;
  }

  async findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null> {
    const id = this.invoiceByOrgFolio.get(`${organizationId}:${folioFiscal}`);
    return id ? (this.invoices.get(id) ?? null) : null;
  }

  async listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean; readonly periodo?: string; readonly fechaDesde?: string; readonly fechaHasta?: string }): Promise<readonly InvoiceRecord[]> {
    // Filtro por período (migración 006, corregido — ver repository.ts): resuelto
    // directo contra `fecha` (fecha real de emisión del CFDI, "YYYY-MM-DD"), nunca
    // contra el jsonb `diot.proveedoresReportables` (solo existe para un CFDI tipo
    // 'I' con subtotal>0) ni contra `createdAt` (fecha de ingesta).
    return [...this.invoices.values()]
      .filter((i) => i.propertyId === propertyId)
      .filter((i) => filter?.requiresHumanReview === undefined || i.requiresHumanReview === filter.requiresHumanReview)
      .filter((i) => filter?.periodo === undefined || i.fecha.slice(0, 7) === filter.periodo)
      .filter((i) => filter?.fechaDesde === undefined || i.fecha.slice(0, 10) >= filter.fechaDesde)
      .filter((i) => filter?.fechaHasta === undefined || i.fecha.slice(0, 10) <= filter.fechaHasta)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async listInvoicesPage(propertyId: string, opts: { readonly limit: number; readonly offset: number; readonly requiresHumanReview?: boolean; readonly direccion?: DireccionCfdi }): Promise<InvoicePage> {
    const filtered = [...this.invoices.values()]
      .filter((i) => i.propertyId === propertyId)
      .filter((i) => opts.requiresHumanReview === undefined || i.requiresHumanReview === opts.requiresHumanReview)
      .filter((i) => opts.direccion === undefined || i.direccion === opts.direccion)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const items = filtered.slice(opts.offset, opts.offset + opts.limit);
    const nextOffset = opts.offset + items.length < filtered.length ? opts.offset + items.length : null;
    return { items, total: filtered.length, nextOffset };
  }

  // ---- Cola de revisión humana ----

  async createReview(input: NewInvoiceReviewInput): Promise<InvoiceReviewRecord> {
    const id = randomUUID();
    const record: InvoiceReviewRecord = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      invoiceId: input.invoiceId,
      reason: input.reason,
      status: "pendiente",
      decisionNote: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.reviews.set(id, record);
    return record;
  }

  async listPendingReviews(propertyId: string): Promise<readonly InvoiceReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((r) => r.propertyId === propertyId && r.status === "pendiente")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async findReview(propertyId: string, reviewId: string): Promise<InvoiceReviewRecord | null> {
    const review = this.reviews.get(reviewId);
    if (!review || review.propertyId !== propertyId) return null;
    return review;
  }

  async resolveReview(propertyId: string, reviewId: string, resolvedBy: string, status: InvoiceReviewStatus, decisionNote: string | null): Promise<InvoiceReviewRecord> {
    const review = this.reviews.get(reviewId);
    if (!review || review.propertyId !== propertyId) throw new Error(`Revisión ${reviewId} no encontrada.`);
    if (review.status !== "pendiente") throw new InvoiceReviewAlreadyResolvedError();
    const updated: InvoiceReviewRecord = { ...review, status, decisionNote, resolvedBy, resolvedAt: new Date().toISOString() };
    this.reviews.set(reviewId, updated);
    return updated;
  }

  // ---- Vencimientos fiscales ----

  async createDeadline(input: NewFiscalDeadlineInput): Promise<FiscalDeadlineRecord> {
    // Espejo de `unique (property_id, tipo, periodo)` de migrations/001 — calcular
    // vencimientos del mismo período dos veces nunca duplica la fila.
    const clash = [...this.deadlines.values()].find((d) => d.propertyId === input.propertyId && d.tipo === input.tipo && d.periodo === input.periodo);
    if (clash) return clash;
    const id = randomUUID();
    const record: FiscalDeadlineRecord = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      tipo: input.tipo,
      periodo: input.periodo,
      fechaLimite: input.fechaLimite,
      prioridad: input.prioridad,
      estado: "pendiente",
      fechaPresentacion: null,
      comprobanteUrl: null,
      createdAt: new Date().toISOString(),
    };
    this.deadlines.set(id, record);
    return record;
  }

  async listDeadlines(propertyId: string, filter?: { readonly estado?: string }): Promise<readonly FiscalDeadlineRecord[]> {
    // Mismo desempate `, id asc` que `PostgresDespachosRepository.listDeadlines` --
    // orden total y estable entre los 4 tipos de un mismo periodo, que siempre
    // comparten `fechaLimite` (ver comentario ahí).
    return [...this.deadlines.values()]
      .filter((d) => d.propertyId === propertyId)
      .filter((d) => !filter?.estado || d.estado === filter.estado)
      .sort((a, b) => (a.fechaLimite === b.fechaLimite ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.fechaLimite < b.fechaLimite ? -1 : 1));
  }

  async findDeadline(propertyId: string, deadlineId: string): Promise<FiscalDeadlineRecord | null> {
    const deadline = this.deadlines.get(deadlineId);
    if (!deadline || deadline.propertyId !== propertyId) return null;
    return deadline;
  }

  async markDeadlineCompleted(deadlineId: string, comprobanteUrl: string | null, fechaPresentacion: string): Promise<FiscalDeadlineRecord | null> {
    const deadline = this.deadlines.get(deadlineId);
    if (!deadline) return null;
    const updated: FiscalDeadlineRecord = { ...deadline, estado: "completado", comprobanteUrl: comprobanteUrl ?? deadline.comprobanteUrl, fechaPresentacion };
    this.deadlines.set(deadlineId, updated);
    return updated;
  }

  async updateDeadlineEstado(deadlineId: string, estado: FiscalDeadlineRecord["estado"]): Promise<void> {
    const deadline = this.deadlines.get(deadlineId);
    if (!deadline) throw new Error(`Vencimiento ${deadlineId} no encontrado.`);
    this.deadlines.set(deadlineId, { ...deadline, estado });
  }

  async updateDeadlineFechaLimite(deadlineId: string, fechaLimite: string, prioridad: FiscalDeadlineRecord["prioridad"]): Promise<FiscalDeadlineRecord | null> {
    const deadline = this.deadlines.get(deadlineId);
    if (!deadline || deadline.estado === "completado") return null;
    const updated: FiscalDeadlineRecord = { ...deadline, fechaLimite, prioridad };
    this.deadlines.set(deadlineId, updated);
    return updated;
  }

  async insertEscalation(deadlineId: string, level: NivelEscalamiento, sentAt: string, notes: string): Promise<DeadlineEscalationRecord> {
    const record: DeadlineEscalationRecord = { id: randomUUID(), deadlineId, level, sentAt, notes };
    const list = this.escalations.get(deadlineId) ?? [];
    list.push(record);
    this.escalations.set(deadlineId, list);
    return record;
  }

  async listEscalations(deadlineId: string): Promise<readonly DeadlineEscalationRecord[]> {
    return this.escalations.get(deadlineId) ?? [];
  }

  // ---- Migración de catálogo contable (Fase 5) ----

  async insertMapeoMigracion(
    input: NewMapeoMigracionInput & { readonly tipoMatch: MapeoMigracionCuenta["tipoMatch"]; readonly score: number; readonly estado: MapeoMigracionCuenta["estado"] },
  ): Promise<MapeoMigracionCuenta> {
    const now = new Date().toISOString();
    const record: MapeoMigracionCuenta = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      origenCuentaId: input.origenCuentaId,
      destinoCuentaId: input.destinoCuentaId,
      tipoMatch: input.tipoMatch,
      score: input.score,
      estado: input.estado,
      aprobadoPor: null,
      aprobadoEn: null,
      nota: input.nota,
      estrategiaConciliacionSaldos: null,
      createdAt: now,
      updatedAt: now,
    };
    this.mapeosMigracion.set(record.id, record);
    return record;
  }

  async findMapeoMigracion(propertyId: string, mapeoId: string): Promise<MapeoMigracionCuenta | null> {
    const mapeo = this.mapeosMigracion.get(mapeoId);
    if (!mapeo || mapeo.propertyId !== propertyId) return null;
    return mapeo;
  }

  async listMapeosMigracion(propertyId: string, filter?: { readonly estado?: MapeoMigracionCuenta["estado"] }): Promise<readonly MapeoMigracionCuenta[]> {
    return [...this.mapeosMigracion.values()]
      .filter((m) => m.propertyId === propertyId)
      .filter((m) => !filter?.estado || m.estado === filter.estado)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async updateMapeoMigracion(mapeo: MapeoMigracionCuenta): Promise<MapeoMigracionCuenta> {
    if (!this.mapeosMigracion.has(mapeo.id)) throw new Error(`Mapeo de migración ${mapeo.id} no encontrado.`);
    this.mapeosMigracion.set(mapeo.id, mapeo);
    return mapeo;
  }

  // ---- Cierre mensual (Fase 6) ----

  async insertPeriodoCierre(input: NewPeriodoCierreInput): Promise<{ readonly periodo: ClosePeriod; readonly tareas: readonly CloseTask[] }> {
    const nuevas = construirTareasDesdePlantilla(input.anio, input.mes, input.template);
    const periodoId = randomUUID();
    const now = new Date().toISOString();
    const periodo: ClosePeriod = {
      id: periodoId,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      year: input.anio,
      month: input.mes,
      status: "open",
      openedAt: now,
      closedAt: null,
      closedBy: null,
    };

    const keyToId = new Map<string, string>();
    const conId = nuevas.map((t) => {
      const id = randomUUID();
      if (t.key) keyToId.set(t.key, id);
      return { id, ...t };
    });
    const tareas: CloseTask[] = conId.map((t) => ({
      id: t.id,
      periodId: periodoId,
      title: t.title,
      description: t.description,
      category: t.category,
      status: t.status,
      dependsOn: t.dependsOnKeys.map((k) => keyToId.get(k)).filter((x): x is string => x !== undefined),
      dueDate: t.dueDate,
      autoCheckQuery: t.autoCheckQuery,
      required: t.required,
      completedAt: null,
      completedBy: null,
    }));

    this.periodosCierre.set(periodoId, periodo);
    this.tareasCierre.set(periodoId, tareas);
    return { periodo, tareas };
  }

  async findPeriodoCierre(propertyId: string, periodoId: string): Promise<ClosePeriod | null> {
    const p = this.periodosCierre.get(periodoId);
    return p && p.propertyId === propertyId ? p : null;
  }

  async findPeriodoCierrePorAnioMes(propertyId: string, anio: number, mes: number): Promise<ClosePeriod | null> {
    return [...this.periodosCierre.values()].find((p) => p.propertyId === propertyId && p.year === anio && p.month === mes) ?? null;
  }

  async listPeriodosCierre(propertyId: string): Promise<readonly ClosePeriod[]> {
    return [...this.periodosCierre.values()]
      .filter((p) => p.propertyId === propertyId)
      .sort((a, b) => (a.year !== b.year ? b.year - a.year : b.month - a.month));
  }

  async listTareasCierre(periodoId: string): Promise<readonly CloseTask[]> {
    return this.tareasCierre.get(periodoId) ?? [];
  }

  async updatePeriodoCierre(periodo: ClosePeriod): Promise<ClosePeriod> {
    if (!this.periodosCierre.has(periodo.id)) throw new Error(`Período de cierre ${periodo.id} no encontrado.`);
    this.periodosCierre.set(periodo.id, periodo);
    return periodo;
  }

  async replaceTareasCierre(periodoId: string, tareas: readonly CloseTask[]): Promise<readonly CloseTask[]> {
    const copia = [...tareas];
    this.tareasCierre.set(periodoId, copia);
    return copia;
  }

  // ---- Cobranza (Fase 10) ----

  async registerReceivable(input: NewReceivableInput): Promise<ReceivableRecord> {
    if (this.receivableByInvoice.has(input.invoiceId)) {
      throw new ReceivableAlreadyExistsError(input.invoiceId);
    }
    const id = randomUUID();
    const record: ReceivableRecord = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      invoiceId: input.invoiceId,
      fechaVencimiento: input.fechaVencimiento,
      montoPagado: null,
      pagadoEn: null,
      clienteNombre: input.clienteNombre ?? null,
      clienteEmail: input.clienteEmail ?? null,
      createdAt: new Date().toISOString(),
    };
    this.receivables.set(id, record);
    this.receivableByInvoice.set(input.invoiceId, id);
    return record;
  }

  async findReceivable(propertyId: string, receivableId: string): Promise<ReceivableRecord | null> {
    const receivable = this.receivables.get(receivableId);
    if (!receivable || receivable.propertyId !== propertyId) return null;
    return receivable;
  }

  async findReceivableByInvoice(propertyId: string, invoiceId: string): Promise<ReceivableRecord | null> {
    const id = this.receivableByInvoice.get(invoiceId);
    if (!id) return null;
    return this.findReceivable(propertyId, id);
  }

  async listReceivables(propertyId: string, filter?: { readonly pendiente?: boolean }): Promise<readonly ReceivableRecord[]> {
    return [...this.receivables.values()]
      .filter((r) => r.propertyId === propertyId)
      .filter((r) => !filter?.pendiente || r.pagadoEn === null)
      .sort((a, b) => (a.fechaVencimiento < b.fechaVencimiento ? -1 : 1));
  }

  async markReceivablePaid(propertyId: string, receivableId: string, paidAtIso: string, montoPagado: number | null): Promise<ReceivableRecord> {
    const receivable = this.receivables.get(receivableId);
    if (!receivable || receivable.propertyId !== propertyId) throw new Error(`Cuenta por cobrar ${receivableId} no encontrada.`);
    if (receivable.pagadoEn !== null) throw new ReceivableAlreadyPaidError();
    const updated: ReceivableRecord = { ...receivable, pagadoEn: paidAtIso, montoPagado };
    this.receivables.set(receivableId, updated);
    return updated;
  }

  async insertCollectionEvent(input: NewCollectionEventInput): Promise<CollectionEventRecord> {
    const record: CollectionEventRecord = {
      id: randomUUID(),
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      receivableId: input.receivableId,
      etapa: input.etapa,
      canal: input.canal,
      respuesta: input.respuesta,
      createdAt: new Date().toISOString(),
    };
    const list = this.collectionEvents.get(input.receivableId) ?? [];
    list.push(record);
    this.collectionEvents.set(input.receivableId, list);
    return record;
  }

  async listCollectionEvents(propertyId: string, receivableId: string): Promise<readonly CollectionEventRecord[]> {
    return (this.collectionEvents.get(receivableId) ?? []).filter((e) => e.propertyId === propertyId);
  }

  async listCollectionEventsForReceivables(propertyId: string, receivableIds: readonly string[]): Promise<readonly CollectionEventRecord[]> {
    this.llamadasListCollectionEventsForReceivables += 1;
    const resultado: CollectionEventRecord[] = [];
    for (const receivableId of receivableIds) {
      for (const evento of this.collectionEvents.get(receivableId) ?? []) {
        if (evento.propertyId === propertyId) resultado.push(evento);
      }
    }
    return resultado;
  }

  // ---- Flujos de sistema (cron `cobranza-reminders`) -- ver DespachosRepository. ----

  async systemListPendingReceivablesForReminders(propertyId: string): Promise<readonly ReceivableReminderRow[]> {
    const pendientes = await this.listReceivables(propertyId, { pendiente: true });
    const rows: ReceivableReminderRow[] = [];
    for (const r of pendientes) {
      const invoice = this.invoices.get(r.invoiceId);
      if (!invoice) continue; // mismo criterio "honesto" que el INNER JOIN real -- dato inconsistente, se salta.
      rows.push({
        id: r.id,
        organizationId: r.organizationId,
        propertyId: r.propertyId,
        invoiceId: r.invoiceId,
        fechaVencimiento: r.fechaVencimiento,
        clienteNombre: r.clienteNombre,
        clienteEmail: r.clienteEmail,
        facturaFolioFiscal: invoice.folioFiscal,
        facturaTotal: invoice.total,
      });
    }
    return rows;
  }

  async systemRecordCollectionEvent(input: NewSystemCollectionEventInput): Promise<CollectionEventRecord | null> {
    const yaRegistrado = (this.collectionEvents.get(input.receivableId) ?? []).some(
      (e) => e.etapa === input.etapa && e.createdAt.slice(0, 10) === input.eventDate,
    );
    if (yaRegistrado) return null; // dedupe -- mismo criterio best-effort que la función real.
    return this.insertCollectionEvent(input);
  }

  // ============================================================================
  // Infraestructura de correo (migración 005) — outbox real acotado a
  // channel='email', mismo patrón EXACTO que InMemoryCitasRepository/
  // InMemoryLicitacionesRepository (leídos primero como plantilla).
  // ============================================================================

  async listActiveOrganizations(): Promise<readonly { id: string }[]> {
    return [...this.organizations.values()].filter((o) => o.isActive).map((o) => ({ id: o.id }));
  }

  async listOrganizationNotificationRecipients(organizationId: string): Promise<readonly OrganizationNotificationRecipient[]> {
    return [...(this.notificationRecipients.get(organizationId) ?? [])];
  }

  async enqueueMessagingOutbox(organizationId: string, channel: "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    if (channel !== "email") throw new Error("invalid outbox channel");
    const dedupeMapKey = `${organizationId}:${channel}:${dedupeKey}`;
    const existingId = this.messagingOutboxDedupe.get(dedupeMapKey);
    if (existingId) {
      const existing = this.messagingOutbox.get(existingId)!;
      // Mismo criterio que `despachos.enqueue_messaging_outbox` real: un job ya
      // 'sent'/'processing'/'dead' NUNCA se pisa -- solo 'pending'/'failed' se actualizan.
      if (existing.status === "pending" || existing.status === "failed") {
        this.messagingOutbox.set(existingId, { ...existing, payload: payload as Record<string, unknown>, eventType });
      }
      return;
    }
    const id = randomUUID();
    this.messagingOutbox.set(id, {
      id,
      organizationId,
      channel,
      eventType,
      dedupeKey,
      payload: payload as Record<string, unknown>,
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    });
    this.messagingOutboxDedupe.set(dedupeMapKey, id);
  }

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const claimable = [...this.messagingOutbox.values()]
      .filter((j) => j.channel === "email" && (j.status === "pending" || j.status === "failed") && j.attempts < 5)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(limit, 0));
    const claimed: EmailOutboxJobRow[] = [];
    for (const job of claimable) {
      const updated = { ...job, status: "processing" as const, attempts: job.attempts + 1 };
      this.messagingOutbox.set(job.id, updated);
      claimed.push({ id: updated.id, organizationId: updated.organizationId, attempts: updated.attempts, payload: updated.payload });
    }
    return claimed;
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    if (!["sent", "failed", "dead"].includes(status)) throw new Error(`invalid email outbox completion status: ${status}`);
    const job = this.messagingOutbox.get(id);
    if (!job || job.channel !== "email") return;
    this.messagingOutbox.set(id, { ...job, status, lastError: error ? error.slice(0, 500) : null });
  }

  // Ver el comentario de cabecera de `runWithRowSavepoint` en `repository.ts`. `fn`
  // corre directo y su error (si lo hay) se repropaga tal cual -- mismo
  // comportamiento observable que tendría un SAVEPOINT+ROLLBACK TO SAVEPOINT real
  // desde el punto de vista del caller, sin transacción real que aislar en memoria.
  async runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  // ---- Libro de estados de cuenta importados (D-03, migración 015) ----
  private readonly estadoCuentaHashes = new Map<string, Set<string>>();
  /** Movimientos completos del libro (D-35: la conciliación persistida los lee por periodo). */
  private readonly estadoCuentaMovimientos = new Map<string, Array<NuevoMovimientoEstadoCuenta & { readonly id: string }>>();

  /** Doble en memoria de `select ... from despachos.estado_cuenta_movimiento where property_id = $1` (solo lectura, para el doble de la conciliación persistida). */
  listEstadoCuentaMovimientosGuardados(propertyId: string): readonly (NuevoMovimientoEstadoCuenta & { readonly id: string })[] {
    return this.estadoCuentaMovimientos.get(propertyId) ?? [];
  }

  async listEstadoCuentaHashesExistentes(propertyId: string, hashes: readonly string[]): Promise<ReadonlySet<string>> {
    const guardados = this.estadoCuentaHashes.get(propertyId);
    return new Set(hashes.filter((h) => guardados?.has(h)));
  }

  async insertEstadoCuentaMovimientos(lote: NuevoLoteEstadoCuenta): Promise<ResultadoGuardadoEstadoCuenta> {
    const guardados = this.estadoCuentaHashes.get(lote.propertyId) ?? new Set<string>();
    let insertados = 0;
    for (const m of lote.movimientos) {
      if (guardados.has(m.hash)) continue;
      guardados.add(m.hash);
      const lista = this.estadoCuentaMovimientos.get(lote.propertyId) ?? [];
      lista.push({ ...m, id: randomUUID() });
      this.estadoCuentaMovimientos.set(lote.propertyId, lista);
      insertados++;
    }
    this.estadoCuentaHashes.set(lote.propertyId, guardados);
    return { loteId: lote.loteId, insertados, yaExistentes: lote.movimientos.length - insertados };
  }

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 012) ----
  async findPropertyConfig(propertyId: string): Promise<DespachosPropertyConfigRecord | null> {
    return this.propertyConfigs.get(propertyId) ?? null;
  }

  async upsertPropertyConfigZonaHoraria(propertyId: string, organizationId: string, zonaHoraria: string | null): Promise<DespachosPropertyConfigRecord> {
    const record: DespachosPropertyConfigRecord = { propertyId, organizationId, zonaHoraria };
    this.propertyConfigs.set(propertyId, record);
    return record;
  }

  // ---- D-04: lista 69-B (EFOS) ----
  private efosPeriodoVigente(): string | null {
    const periodos = [...this.efosListas.keys()].sort();
    return periodos.length > 0 ? periodos[periodos.length - 1]! : null;
  }

  async consultarEfos(rfcs: readonly string[]): Promise<EfosConsulta> {
    const periodo = this.efosPeriodoVigente();
    if (periodo === null) return EFOS_NO_DISPONIBLE;
    const buscados = new Set(rfcs.map((r) => r.trim().toUpperCase()));
    return { estado: "disponible", periodoLista: periodo, coincidencias: this.efosListas.get(periodo)!.filas.filter((f) => buscados.has(f.rfc)) };
  }

  async estadoEfos(): Promise<EfosEstadoLista> {
    const periodo = this.efosPeriodoVigente();
    if (periodo === null) return { estado: "no_disponible", periodo: null, filas: null, ingestadoEn: null };
    const l = this.efosListas.get(periodo)!;
    return { estado: "disponible", periodo, filas: l.filas.length, ingestadoEn: l.ingestadoEn };
  }

  async listarInvoicesEfosAfectados(propertyId: string): Promise<EfosAfectadosResultado> {
    const periodo = this.efosPeriodoVigente();
    if (periodo === null) return { estado: "no_disponible", items: [] };
    const porRfc = new Map(this.efosListas.get(periodo)!.filas.map((f) => [f.rfc, f] as const));
    const items = [...this.invoices.values()]
      .filter((i) => i.propertyId === propertyId)
      .flatMap((i) => {
        const c = porRfc.get(i.rfcEmisor.trim().toUpperCase());
        if (!c || (c.situacion !== "presunto" && c.situacion !== "definitivo")) return [];
        return [{ invoiceId: i.id, folioFiscal: i.folioFiscal, rfcEmisor: i.rfcEmisor, emisorNombre: i.emisorNombre, fecha: i.fecha, total: i.total, situacion: c.situacion, periodoLista: periodo }];
      })
      .sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0))
      .slice(0, 500);
    return { estado: "disponible", items };
  }

  async ingestarListaEfos(periodo: string, fuenteSha256: string, filas: readonly EfosContribuyente[]): Promise<EfosIngestaResultado> {
    if (filas.length === 0) throw new Error("ingestarListaEfos: lista vacía");
    if (new Set(filas.map((f) => f.rfc)).size !== filas.length) throw new Error("ingestarListaEfos: RFC duplicado dentro de la edición");
    const previa = this.efosListas.get(periodo);
    if (previa && previa.sha === fuenteSha256) return "sin_cambios";
    this.efosListas.set(periodo, { sha: fuenteSha256, filas: [...filas], ingestadoEn: new Date().toISOString() });
    return previa ? "reemplazada" : "insertada";
  }
}
