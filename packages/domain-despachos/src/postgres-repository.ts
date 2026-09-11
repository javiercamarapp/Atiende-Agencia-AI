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

export class PostgresDespachosRepository implements DespachosRepository {
  constructor(private readonly db: TenantDbSession) {}

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

  async listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean }): Promise<readonly InvoiceRecord[]> {
    if (filter?.requiresHumanReview !== undefined) {
      const { rows } = await this.db.query<InvoiceRawRow>(
        `select * from despachos.invoice where property_id = $1 and requires_human_review = $2 order by created_at desc;`,
        [propertyId, filter.requiresHumanReview],
      );
      return rows.map(mapInvoice);
    }
    const { rows } = await this.db.query<InvoiceRawRow>(`select * from despachos.invoice where property_id = $1 order by created_at desc;`, [propertyId]);
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
}
