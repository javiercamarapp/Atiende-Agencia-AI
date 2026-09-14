// PostgresDespachosRepository — adaptador de producción de `DespachosRepository`,
// sobre el `TenantDbSession` genérico de `@atiende/core-tenancy` (mismo contrato que
// consume `core-auth/src/middleware.ts`). Ejecuta las queries reales contra el
// esquema `despachos` de migrations/001 (RLS real vía `core.has_property_access`).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { HallazgoCfdi } from "@atiende/billing";
import { InvoiceAlreadyExistsError, InvoiceReviewAlreadyResolvedError } from "./errors.ts";
import type { DespachosRepository } from "./repository.ts";
import type {
  CategoriaContable,
  DeadlineEscalationRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
  TipoComprobante,
} from "./types.ts";
import type { DiotResult } from "./cfdi/reglas-fiscales-avanzadas.ts";
import type { EstadoVencimiento, NivelEscalamiento, PrioridadVencimiento, TipoVencimiento } from "./vencimientos/engine.ts";
import type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
import { construirTareasDesdePlantilla } from "./cierre-mensual/engine.ts";
import type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";
import type { ClosePeriod, CloseTask } from "./cierre-mensual/types.ts";

interface MapeoMigracionRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  origen_cuenta_id: string;
  destino_cuenta_id: string | null;
  tipo_match: MapeoMigracionCuenta["tipoMatch"];
  score: string;
  estado: MapeoMigracionCuenta["estado"];
  aprobado_por: string | null;
  aprobado_en: string | null;
  nota: string | null;
  estrategia_conciliacion_saldos: string | null;
  created_at: string;
  updated_at: string;
}

function mapMapeoMigracion(row: MapeoMigracionRawRow): MapeoMigracionCuenta {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    origenCuentaId: row.origen_cuenta_id,
    destinoCuentaId: row.destino_cuenta_id,
    tipoMatch: row.tipo_match,
    score: Number(row.score),
    estado: row.estado,
    aprobadoPor: row.aprobado_por,
    aprobadoEn: row.aprobado_en,
    nota: row.nota,
    estrategiaConciliacionSaldos: row.estrategia_conciliacion_saldos,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Código de error de Postgres para violación de restricción unique (23505) — mismo
// criterio que el resto del monorepo detecta conflictos de idempotencia/unicidad
// mapeando el código de error nativo en vez de hacer un SELECT-then-INSERT con
// condición de carrera.
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

interface InvoiceRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  folio_fiscal: string;
  tipo: TipoComprobante;
  rfc_emisor: string;
  rfc_receptor: string;
  emisor_nombre: string | null;
  subtotal: string;
  total: string;
  iva: string | null;
  descuento: string;
  categoria: CategoriaContable;
  confianza: string | null;
  valido: boolean;
  issues: HallazgoCfdi[];
  warnings: string[];
  requires_human_review: boolean;
  diot: DiotResult;
  created_at: string;
}

function mapInvoice(row: InvoiceRawRow): InvoiceRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    folioFiscal: row.folio_fiscal,
    tipo: row.tipo,
    rfcEmisor: row.rfc_emisor,
    rfcReceptor: row.rfc_receptor,
    emisorNombre: row.emisor_nombre,
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    iva: row.iva === null ? null : Number(row.iva),
    descuento: Number(row.descuento),
    categoria: row.categoria,
    confianza: row.confianza === null ? null : Number(row.confianza),
    valido: row.valido,
    issues: row.issues,
    warnings: row.warnings,
    requiresHumanReview: row.requires_human_review,
    diot: row.diot,
    createdAt: row.created_at,
  };
}

interface InvoiceReviewRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  invoice_id: string;
  reason: string;
  status: InvoiceReviewStatus;
  decision_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

function mapReview(row: InvoiceReviewRawRow): InvoiceReviewRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    invoiceId: row.invoice_id,
    reason: row.reason,
    status: row.status,
    decisionNote: row.decision_note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

interface FiscalDeadlineRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  tipo: TipoVencimiento;
  periodo: string;
  fecha_limite: string;
  prioridad: PrioridadVencimiento;
  estado: EstadoVencimiento;
  fecha_presentacion: string | null;
  comprobante_url: string | null;
  created_at: string;
}

function mapDeadline(row: FiscalDeadlineRawRow): FiscalDeadlineRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    tipo: row.tipo,
    periodo: row.periodo,
    fechaLimite: row.fecha_limite,
    prioridad: row.prioridad,
    estado: row.estado,
    fechaPresentacion: row.fecha_presentacion,
    comprobanteUrl: row.comprobante_url,
    createdAt: row.created_at,
  };
}

interface EscalationRawRow {
  id: string;
  deadline_id: string;
  level: NivelEscalamiento;
  sent_at: string;
  notes: string;
}

function mapEscalation(row: EscalationRawRow): DeadlineEscalationRecord {
  return { id: row.id, deadlineId: row.deadline_id, level: row.level, sentAt: row.sent_at, notes: row.notes };
}

interface PeriodoCierreRawRow {
  id: string;
  organization_id: string;
  property_id: string;
  anio: number;
  mes: number;
  status: ClosePeriod["status"];
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

function mapPeriodoCierre(row: PeriodoCierreRawRow): ClosePeriod {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    year: row.anio,
    month: row.mes,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
  };
}

interface TareaCierreRawRow {
  id: string;
  periodo_cierre_id: string;
  title: string;
  description: string;
  category: CloseTask["category"];
  status: CloseTask["status"];
  depends_on: string[];
  due_date: string | null;
  auto_check_query: string | null;
  required: boolean;
  completed_at: string | null;
  completed_by: string | null;
}

function mapTareaCierre(row: TareaCierreRawRow): CloseTask {
  return {
    id: row.id,
    periodId: row.periodo_cierre_id,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    dependsOn: row.depends_on ?? [],
    dueDate: row.due_date,
    autoCheckQuery: row.auto_check_query,
    required: row.required,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
  };
}

export class PostgresDespachosRepository implements DespachosRepository {
  constructor(private readonly db: TenantDbSession) {}

  // ---- Fase 9 (paridad de UI del panel web) — resolución de organización/property
  // desde el slug de la organización. Mismo patrón EXACTO que
  // `PostgresLicitacionesRepository.findOrganizationBySlug`/
  // `listPropertiesForOrganization`: lee directo de `core.organization`/
  // `core.property` (esquema núcleo compartido entre verticales, migración
  // 0001_core_schema.sql), sin tabla propia de despachos para esto. ----

  async findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null> {
    const { rows } = await this.db.query<{ id: string; name: string; slug: string; status: "trial" | "active" | "suspended" }>(
      `select id, name, slug, status from core.organization where slug = $1 and vertical = 'despachos';`,
      [slug],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, slug: row.slug, isActive: row.status === "active" } : null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string }>(
      `select id as property_id, name from core.property where organization_id = $1 and status = 'active' order by name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name }));
  }

  // ---- CFDI ----

  async insertInvoice(input: NewInvoiceInput): Promise<InvoiceRecord> {
    try {
      const { rows } = await this.db.query<InvoiceRawRow>(
        `insert into despachos.invoice
           (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, emisor_nombre,
            subtotal, total, iva, descuento, categoria, valido, issues, warnings, requires_human_review, diot)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17::jsonb)
         returning *;`,
        [
          input.organizationId,
          input.propertyId,
          input.folioFiscal,
          input.tipo,
          input.rfcEmisor,
          input.rfcReceptor,
          input.emisorNombre,
          input.subtotal,
          input.total,
          input.iva,
          input.descuento,
          input.categoria,
          input.valido,
          JSON.stringify(input.issues),
          JSON.stringify(input.warnings),
          input.requiresHumanReview,
          JSON.stringify(input.diot),
        ],
      );
      return mapInvoice(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new InvoiceAlreadyExistsError(input.folioFiscal);
      throw err;
    }
  }

  async findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null> {
    const { rows } = await this.db.query<InvoiceRawRow>(`select * from despachos.invoice where id = $1 and property_id = $2;`, [invoiceId, propertyId]);
    return rows[0] ? mapInvoice(rows[0]) : null;
  }

  async findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null> {
    const { rows } = await this.db.query<InvoiceRawRow>(`select * from despachos.invoice where organization_id = $1 and folio_fiscal = $2;`, [organizationId, folioFiscal]);
    return rows[0] ? mapInvoice(rows[0]) : null;
  }

  async listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean; readonly periodo?: string }): Promise<readonly InvoiceRecord[]> {
    // Filtro por período (Fase 2, aditivo — ver repository.ts): sin migración de
    // esquema nueva, resuelto contra el jsonb `diot.proveedoresReportables` ya
    // persistido (un invoice es del período si al menos un registro reportable
    // coincide con "YYYY-MM").
    const conditions = ["property_id = $1"];
    const params: unknown[] = [propertyId];
    if (filter?.requiresHumanReview !== undefined) {
      params.push(filter.requiresHumanReview);
      conditions.push(`requires_human_review = $${params.length}`);
    }
    if (filter?.periodo !== undefined) {
      params.push(filter.periodo);
      conditions.push(`exists (select 1 from jsonb_array_elements(diot->'proveedoresReportables') as p where p->>'periodo' = $${params.length})`);
    }
    const { rows } = await this.db.query<InvoiceRawRow>(`select * from despachos.invoice where ${conditions.join(" and ")} order by created_at desc;`, params);
    return rows.map(mapInvoice);
  }

  // ---- Cola de revisión humana ----

  async createReview(input: NewInvoiceReviewInput): Promise<InvoiceReviewRecord> {
    const { rows } = await this.db.query<InvoiceReviewRawRow>(
      `insert into despachos.invoice_review (organization_id, property_id, invoice_id, reason)
       values ($1, $2, $3, $4) returning *;`,
      [input.organizationId, input.propertyId, input.invoiceId, input.reason],
    );
    return mapReview(rows[0]!);
  }

  async listPendingReviews(propertyId: string): Promise<readonly InvoiceReviewRecord[]> {
    const { rows } = await this.db.query<InvoiceReviewRawRow>(
      `select * from despachos.invoice_review where property_id = $1 and status = 'pendiente' order by created_at asc;`,
      [propertyId],
    );
    return rows.map(mapReview);
  }

  async findReview(propertyId: string, reviewId: string): Promise<InvoiceReviewRecord | null> {
    const { rows } = await this.db.query<InvoiceReviewRawRow>(`select * from despachos.invoice_review where id = $1 and property_id = $2;`, [reviewId, propertyId]);
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async resolveReview(propertyId: string, reviewId: string, resolvedBy: string, status: InvoiceReviewStatus, decisionNote: string | null): Promise<InvoiceReviewRecord> {
    const { rows } = await this.db.query<InvoiceReviewRawRow>(
      `update despachos.invoice_review
         set status = $1, decision_note = $2, resolved_by = $3, resolved_at = now()
       where id = $4 and property_id = $5 and status = 'pendiente'
       returning *;`,
      [status, decisionNote, resolvedBy, reviewId, propertyId],
    );
    if (!rows[0]) {
      const existing = await this.findReview(propertyId, reviewId);
      if (!existing) throw new Error(`Revisión ${reviewId} no encontrada.`);
      throw new InvoiceReviewAlreadyResolvedError();
    }
    return mapReview(rows[0]);
  }

  // ---- Vencimientos fiscales ----

  async createDeadline(input: NewFiscalDeadlineInput): Promise<FiscalDeadlineRecord> {
    const { rows } = await this.db.query<FiscalDeadlineRawRow>(
      `insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
       values ($1, $2, $3, $4, $5, $6) returning *;`,
      [input.organizationId, input.propertyId, input.tipo, input.periodo, input.fechaLimite, input.prioridad],
    );
    return mapDeadline(rows[0]!);
  }

  async listDeadlines(propertyId: string, filter?: { readonly estado?: string }): Promise<readonly FiscalDeadlineRecord[]> {
    if (filter?.estado) {
      const { rows } = await this.db.query<FiscalDeadlineRawRow>(
        `select * from despachos.fiscal_deadline where property_id = $1 and estado = $2 order by fecha_limite asc;`,
        [propertyId, filter.estado],
      );
      return rows.map(mapDeadline);
    }
    const { rows } = await this.db.query<FiscalDeadlineRawRow>(`select * from despachos.fiscal_deadline where property_id = $1 order by fecha_limite asc;`, [propertyId]);
    return rows.map(mapDeadline);
  }

  async findDeadline(propertyId: string, deadlineId: string): Promise<FiscalDeadlineRecord | null> {
    const { rows } = await this.db.query<FiscalDeadlineRawRow>(`select * from despachos.fiscal_deadline where id = $1 and property_id = $2;`, [deadlineId, propertyId]);
    return rows[0] ? mapDeadline(rows[0]) : null;
  }

  async markDeadlineCompleted(deadlineId: string, comprobanteUrl: string | null, fechaPresentacion: string): Promise<FiscalDeadlineRecord | null> {
    const { rows } = await this.db.query<FiscalDeadlineRawRow>(
      `update despachos.fiscal_deadline
         set estado = 'completado', comprobante_url = coalesce($1, comprobante_url), fecha_presentacion = $2
       where id = $3
       returning *;`,
      [comprobanteUrl, fechaPresentacion, deadlineId],
    );
    return rows[0] ? mapDeadline(rows[0]) : null;
  }

  async updateDeadlineEstado(deadlineId: string, estado: FiscalDeadlineRecord["estado"]): Promise<void> {
    await this.db.query(`update despachos.fiscal_deadline set estado = $1 where id = $2;`, [estado, deadlineId]);
  }

  async insertEscalation(deadlineId: string, level: NivelEscalamiento, sentAt: string, notes: string): Promise<DeadlineEscalationRecord> {
    const { rows } = await this.db.query<EscalationRawRow>(
      `insert into despachos.deadline_escalation (deadline_id, level, sent_at, notes) values ($1, $2, $3, $4) returning *;`,
      [deadlineId, level, sentAt, notes],
    );
    return mapEscalation(rows[0]!);
  }

  async listEscalations(deadlineId: string): Promise<readonly DeadlineEscalationRecord[]> {
    const { rows } = await this.db.query<EscalationRawRow>(`select * from despachos.deadline_escalation where deadline_id = $1 order by sent_at asc;`, [deadlineId]);
    return rows.map(mapEscalation);
  }

  // ---- Migración de catálogo contable (Fase 5) ----

  async insertMapeoMigracion(
    input: NewMapeoMigracionInput & { readonly tipoMatch: MapeoMigracionCuenta["tipoMatch"]; readonly score: number; readonly estado: MapeoMigracionCuenta["estado"] },
  ): Promise<MapeoMigracionCuenta> {
    const { rows } = await this.db.query<MapeoMigracionRawRow>(
      `insert into despachos.mapeo_migracion_cuenta
         (organization_id, property_id, origen_cuenta_id, destino_cuenta_id, tipo_match, score, estado, nota)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *;`,
      [input.organizationId, input.propertyId, input.origenCuentaId, input.destinoCuentaId, input.tipoMatch, input.score, input.estado, input.nota],
    );
    return mapMapeoMigracion(rows[0]!);
  }

  async findMapeoMigracion(propertyId: string, mapeoId: string): Promise<MapeoMigracionCuenta | null> {
    const { rows } = await this.db.query<MapeoMigracionRawRow>(`select * from despachos.mapeo_migracion_cuenta where id = $1 and property_id = $2;`, [mapeoId, propertyId]);
    return rows[0] ? mapMapeoMigracion(rows[0]) : null;
  }

  async listMapeosMigracion(propertyId: string, filter?: { readonly estado?: MapeoMigracionCuenta["estado"] }): Promise<readonly MapeoMigracionCuenta[]> {
    const conditions = ["property_id = $1"];
    const params: unknown[] = [propertyId];
    if (filter?.estado !== undefined) {
      params.push(filter.estado);
      conditions.push(`estado = $${params.length}`);
    }
    const { rows } = await this.db.query<MapeoMigracionRawRow>(`select * from despachos.mapeo_migracion_cuenta where ${conditions.join(" and ")} order by created_at asc;`, params);
    return rows.map(mapMapeoMigracion);
  }

  async updateMapeoMigracion(mapeo: MapeoMigracionCuenta): Promise<MapeoMigracionCuenta> {
    const { rows } = await this.db.query<MapeoMigracionRawRow>(
      `update despachos.mapeo_migracion_cuenta
       set destino_cuenta_id = $1, tipo_match = $2, score = $3, estado = $4, aprobado_por = $5, aprobado_en = $6,
           nota = $7, estrategia_conciliacion_saldos = $8, updated_at = now()
       where id = $9
       returning *;`,
      [mapeo.destinoCuentaId, mapeo.tipoMatch, mapeo.score, mapeo.estado, mapeo.aprobadoPor, mapeo.aprobadoEn, mapeo.nota, mapeo.estrategiaConciliacionSaldos, mapeo.id],
    );
    if (!rows[0]) throw new Error(`Mapeo de migración ${mapeo.id} no encontrado.`);
    return mapMapeoMigracion(rows[0]);
  }

  // ---- Cierre mensual (Fase 6) ----

  async insertPeriodoCierre(input: NewPeriodoCierreInput): Promise<{ readonly periodo: ClosePeriod; readonly tareas: readonly CloseTask[] }> {
    const nuevas = construirTareasDesdePlantilla(input.anio, input.mes, input.template);

    const { rows: periodoRows } = await this.db.query<PeriodoCierreRawRow>(
      `insert into despachos.periodo_cierre (organization_id, property_id, anio, mes)
       values ($1, $2, $3, $4) returning *;`,
      [input.organizationId, input.propertyId, input.anio, input.mes],
    );
    const periodo = mapPeriodoCierre(periodoRows[0]!);

    // Inserta cada tarea SIN depends_on primero (para conocer sus IDs reales),
    // luego actualiza depends_on resolviendo las keys de plantilla a esos IDs —
    // mismo problema que `open_period` resuelve en memoria con `key_to_id`
    // antes de construir los objetos; aquí se resuelve en dos pasadas de SQL
    // porque las filas no existen hasta el insert.
    const keyToId = new Map<string, string>();
    const insertadas: TareaCierreRawRow[] = [];
    for (const t of nuevas) {
      const { rows } = await this.db.query<TareaCierreRawRow>(
        `insert into despachos.periodo_cierre_tarea
           (periodo_cierre_id, template_key, title, description, category, status, due_date, auto_check_query, required)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *;`,
        [periodo.id, t.key, t.title, t.description, t.category, t.status, t.dueDate, t.autoCheckQuery, t.required],
      );
      const row = rows[0]!;
      insertadas.push(row);
      if (t.key) keyToId.set(t.key, row.id);
    }

    const tareas: CloseTask[] = [];
    for (let i = 0; i < nuevas.length; i++) {
      const t = nuevas[i]!;
      const row = insertadas[i]!;
      const dependsOn = t.dependsOnKeys.map((k) => keyToId.get(k)).filter((x): x is string => x !== undefined);
      if (dependsOn.length > 0) {
        const { rows } = await this.db.query<TareaCierreRawRow>(`update despachos.periodo_cierre_tarea set depends_on = $1::uuid[] where id = $2 returning *;`, [dependsOn, row.id]);
        tareas.push(mapTareaCierre(rows[0]!));
      } else {
        tareas.push(mapTareaCierre(row));
      }
    }

    return { periodo, tareas };
  }

  async findPeriodoCierre(propertyId: string, periodoId: string): Promise<ClosePeriod | null> {
    const { rows } = await this.db.query<PeriodoCierreRawRow>(`select * from despachos.periodo_cierre where id = $1 and property_id = $2;`, [periodoId, propertyId]);
    return rows[0] ? mapPeriodoCierre(rows[0]) : null;
  }

  async findPeriodoCierrePorAnioMes(propertyId: string, anio: number, mes: number): Promise<ClosePeriod | null> {
    const { rows } = await this.db.query<PeriodoCierreRawRow>(`select * from despachos.periodo_cierre where property_id = $1 and anio = $2 and mes = $3;`, [propertyId, anio, mes]);
    return rows[0] ? mapPeriodoCierre(rows[0]) : null;
  }

  async listPeriodosCierre(propertyId: string): Promise<readonly ClosePeriod[]> {
    const { rows } = await this.db.query<PeriodoCierreRawRow>(`select * from despachos.periodo_cierre where property_id = $1 order by anio desc, mes desc;`, [propertyId]);
    return rows.map(mapPeriodoCierre);
  }

  async listTareasCierre(periodoId: string): Promise<readonly CloseTask[]> {
    const { rows } = await this.db.query<TareaCierreRawRow>(`select * from despachos.periodo_cierre_tarea where periodo_cierre_id = $1;`, [periodoId]);
    return rows.map(mapTareaCierre);
  }

  async updatePeriodoCierre(periodo: ClosePeriod): Promise<ClosePeriod> {
    const { rows } = await this.db.query<PeriodoCierreRawRow>(
      `update despachos.periodo_cierre set status = $1, closed_at = $2, closed_by = $3 where id = $4 returning *;`,
      [periodo.status, periodo.closedAt, periodo.closedBy, periodo.id],
    );
    if (!rows[0]) throw new Error(`Período de cierre ${periodo.id} no encontrado.`);
    return mapPeriodoCierre(rows[0]);
  }

  async replaceTareasCierre(periodoId: string, tareas: readonly CloseTask[]): Promise<readonly CloseTask[]> {
    const out: CloseTask[] = [];
    for (const t of tareas) {
      const { rows } = await this.db.query<TareaCierreRawRow>(
        `update despachos.periodo_cierre_tarea
           set status = $1, depends_on = $2::uuid[], completed_at = $3, completed_by = $4
         where id = $5 and periodo_cierre_id = $6
         returning *;`,
        [t.status, t.dependsOn, t.completedAt, t.completedBy, t.id, periodoId],
      );
      if (rows[0]) out.push(mapTareaCierre(rows[0]));
    }
    return out;
  }
}
