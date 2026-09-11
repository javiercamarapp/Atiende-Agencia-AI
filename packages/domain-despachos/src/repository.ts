// Puerto de acceso a datos de domain-despachos — mismo patrón dual de adaptador que
// domain-hoteles/src/repository.ts y domain-restaurantes/src/repository.ts: un
// puerto TS explícito, con un adaptador real en memoria (tests determinísticos) y un
// adaptador real de Postgres (sobre TenantDbSession, contra migrations/001). Ninguna
// función de negocio de las rutas de apps/api toca SQL directamente.
import type {
  DeadlineEscalationRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
} from "./types.ts";
import type { NivelEscalamiento } from "./vencimientos/engine.ts";

export interface DespachosRepository {
  // ---- CFDI (flujo 1) ----
  /** Lanza `InvoiceAlreadyExistsError` si ya existe un invoice con el mismo
   * (organizationId, folioFiscal) — el folio fiscal (UUID del timbre SAT) es la
   * llave natural de idempotencia de la ingesta: un mismo CFDI reenviado nunca se
   * duplica, sin necesitar un header Idempotency-Key aparte (a diferencia de
   * hoteles/folios, donde "cargo nuevo" no tiene una llave natural propia). */
  insertInvoice(input: NewInvoiceInput): Promise<InvoiceRecord>;
  findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null>;
  listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean }): Promise<readonly InvoiceRecord[]>;

  // ---- Cola de revisión humana (flujo 2) ----
  createReview(input: NewInvoiceReviewInput): Promise<InvoiceReviewRecord>;
  listPendingReviews(propertyId: string): Promise<readonly InvoiceReviewRecord[]>;
  findReview(propertyId: string, reviewId: string): Promise<InvoiceReviewRecord | null>;
  /** Lanza `InvoiceReviewAlreadyResolvedError` si `status` ya no es "pendiente". */
  resolveReview(propertyId: string, reviewId: string, resolvedBy: string, status: InvoiceReviewStatus, decisionNote: string | null): Promise<InvoiceReviewRecord>;

  // ---- Vencimientos fiscales (flujo 3) ----
  createDeadline(input: NewFiscalDeadlineInput): Promise<FiscalDeadlineRecord>;
  listDeadlines(propertyId: string, filter?: { readonly estado?: string }): Promise<readonly FiscalDeadlineRecord[]>;
  findDeadline(propertyId: string, deadlineId: string): Promise<FiscalDeadlineRecord | null>;
  markDeadlineCompleted(deadlineId: string, comprobanteUrl: string | null, fechaPresentacion: string): Promise<FiscalDeadlineRecord | null>;
  updateDeadlineEstado(deadlineId: string, estado: FiscalDeadlineRecord["estado"]): Promise<void>;
  insertEscalation(deadlineId: string, level: NivelEscalamiento, sentAt: string, notes: string): Promise<DeadlineEscalationRecord>;
  listEscalations(deadlineId: string): Promise<readonly DeadlineEscalationRecord[]>;
}

export type { InvoiceRecord, InvoiceReviewRecord, FiscalDeadlineRecord, DeadlineEscalationRecord } from "./types.ts";
