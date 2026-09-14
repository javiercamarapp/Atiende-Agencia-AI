// InMemoryDespachosRepository — implementación real (no un mock) de
// `DespachosRepository`, con las mismas restricciones de integridad que las
// migraciones SQL de migrations/001 (folio_fiscal único por organización). Sirve
// para tests determinísticos y como fallback dev/CI sin Postgres real — mismo rol
// que InMemoryHotelesRepository/InMemoryRestaurantesRepository.
import { randomUUID } from "node:crypto";
import { InvoiceAlreadyExistsError, InvoiceReviewAlreadyResolvedError, ReceivableAlreadyExistsError, ReceivableAlreadyPaidError } from "./errors.ts";
import type { DespachosRepository } from "./repository.ts";
import type {
  CollectionEventRecord,
  DeadlineEscalationRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewCollectionEventInput,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
  NewReceivableInput,
  ReceivableRecord,
} from "./types.ts";
import type { NivelEscalamiento } from "./vencimientos/engine.ts";
import type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
import { construirTareasDesdePlantilla } from "./cierre-mensual/engine.ts";
import type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";
import type { ClosePeriod, CloseTask } from "./cierre-mensual/types.ts";

export class InMemoryDespachosRepository implements DespachosRepository {
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly invoiceByOrgFolio = new Map<string, string>(); // key: organizationId:folioFiscal -> invoiceId
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
  private readonly receivableByInvoice = new Map<string, string>(); // key: invoiceId -> receivableId
  private readonly collectionEvents = new Map<string, CollectionEventRecord[]>(); // key: receivableId

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

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const id = this.organizationIdBySlug.get(slug);
    if (!id) return null;
    return this.organizations.get(id) ?? null;
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
    const record: InvoiceRecord = { id, createdAt: new Date().toISOString(), confianza: null, ...input };
    this.invoices.set(id, record);
    this.invoiceByOrgFolio.set(key, id);
    return record;
  }

  async findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice || invoice.propertyId !== propertyId) return null;
    return invoice;
  }

  async findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null> {
    const id = this.invoiceByOrgFolio.get(`${organizationId}:${folioFiscal}`);
    return id ? (this.invoices.get(id) ?? null) : null;
  }

  async listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean; readonly periodo?: string }): Promise<readonly InvoiceRecord[]> {
    return [...this.invoices.values()]
      .filter((i) => i.propertyId === propertyId)
      .filter((i) => filter?.requiresHumanReview === undefined || i.requiresHumanReview === filter.requiresHumanReview)
      .filter((i) => filter?.periodo === undefined || i.diot.proveedoresReportables.some((p) => p.periodo === filter.periodo))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
    return [...this.deadlines.values()]
      .filter((d) => d.propertyId === propertyId)
      .filter((d) => !filter?.estado || d.estado === filter.estado)
      .sort((a, b) => (a.fechaLimite < b.fechaLimite ? -1 : 1));
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
}
