// Tipos de registro (fila ya mapeada a camelCase) que DespachosRepository devuelve/
// recibe — ninguna función de negocio de las rutas de apps/api toca una fila cruda de
// SQL directamente, mismo criterio que domain-hoteles/src/types.ts y
// domain-restaurantes/src/types.ts.
import type { HallazgoCfdi } from "@atiende/billing";
import type { DiotResult } from "./cfdi/reglas-fiscales-avanzadas.ts";
import type { EstadoVencimiento, NivelEscalamiento, PrioridadVencimiento, TipoVencimiento } from "./vencimientos/engine.ts";
import type { CobranzaReminderStage } from "./cobranza/templates.ts";

export type TipoComprobante = "I" | "E" | "T" | "P" | "N";

/** Clasificación contable — versión mínima de Fase 1. El classifier real
 * (`b2b_ai/features/classifier`, por ClaveProdServ vía CP_CATEGORIAS) es Fase 2; aquí
 * solo se persiste el resultado de una clasificación ya hecha (manual o heurística
 * simple), el invoice NUNCA se auto-clasifica sin que quede el rastro en
 * `invoice_classification`. */
export type CategoriaContable = "gasto_operativo" | "activo_fijo" | "inversion" | "honorarios" | "nomina" | "sin_clasificar";

export interface InvoiceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioFiscal: string;
  readonly tipo: TipoComprobante;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly emisorNombre: string | null;
  readonly subtotal: number;
  readonly total: number;
  readonly iva: number | null;
  readonly descuento: number;
  readonly categoria: CategoriaContable;
  /** null = sin evaluar confianza automática todavía (Fase 1: siempre null salvo que
   * se asigne a mano; el motor de confianza real es Fase 2). */
  readonly confianza: number | null;
  readonly valido: boolean;
  readonly issues: readonly HallazgoCfdi[];
  readonly warnings: readonly string[];
  readonly requiresHumanReview: boolean;
  readonly diot: DiotResult;
  /** Fecha REAL de emisión del CFDI ("YYYY-MM-DD", migración 006) — a diferencia de
   * `createdAt` (fecha de INGESTA). Es la fecha que conciliación bancaria, DIOT,
   * devolución de IVA y declaraciones deben usar para resolver "a qué período
   * pertenece este CFDI"; nunca `createdAt`, y nunca solo el jsonb de DIOT (que
   * únicamente existe para un CFDI tipo 'I' con subtotal>0). */
  readonly fecha: string;
  readonly createdAt: string;
}

export interface NewInvoiceInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folioFiscal: string;
  readonly tipo: TipoComprobante;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly emisorNombre: string | null;
  readonly subtotal: number;
  readonly total: number;
  readonly iva: number | null;
  readonly descuento: number;
  readonly categoria: CategoriaContable;
  readonly valido: boolean;
  readonly issues: readonly HallazgoCfdi[];
  readonly warnings: readonly string[];
  readonly requiresHumanReview: boolean;
  readonly diot: DiotResult;
  /** Ver `InvoiceRecord.fecha` — "YYYY-MM-DD", la fecha real de emisión del CFDI. */
  readonly fecha: string;
}

export type InvoiceReviewStatus = "pendiente" | "aprobado" | "rechazado";

export interface InvoiceReviewRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  /** Por qué se creó la revisión — issues/DIOT/nómina/tipo E-P, ver
   * `resumenParaRevision()` en reglas-fiscales-avanzadas consumers. */
  readonly reason: string;
  readonly status: InvoiceReviewStatus;
  readonly decisionNote: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface NewInvoiceReviewInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly reason: string;
}

export interface FiscalDeadlineRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipo: TipoVencimiento;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly prioridad: PrioridadVencimiento;
  readonly estado: EstadoVencimiento;
  readonly fechaPresentacion: string | null;
  readonly comprobanteUrl: string | null;
  readonly createdAt: string;
}

export interface NewFiscalDeadlineInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipo: TipoVencimiento;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly prioridad: PrioridadVencimiento;
}

export interface DeadlineEscalationRecord {
  readonly id: string;
  readonly deadlineId: string;
  readonly level: NivelEscalamiento;
  readonly sentAt: string;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Cobranza (Fase 10) — puerto de b2b_ai/services/collections.py. Una cuenta
// por cobrar arranca el reloj de cobranza sobre un invoice tipo 'I' ya
// ingerido (`despachos.invoice`, ver `cfdi/`) al registrarle una fecha de
// vencimiento; deliberadamente NO se agrega esa fecha al invoice mismo
// (`InvoiceRecord`/`NewInvoiceInput` no cambian en esta fase) para no romper
// la superficie ya estable de ingesta/validación CFDI — un invoice puede
// ingerirse sin que exista todavía (o nunca) una cuenta por cobrar asociada.
// ---------------------------------------------------------------------------
export interface ReceivableRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly fechaVencimiento: string; // "YYYY-MM-DD"
  readonly montoPagado: number | null;
  readonly pagadoEn: string | null; // ISO 8601, null = todavía pendiente
  /** Contacto real del deudor (migración 005, gap de auditoría) — el CFDI
   * nunca trae un correo de contacto utilizable (`rfc_receptor` es un dato
   * fiscal, no de contacto), así que estos 2 campos son la única fuente real
   * de a quién enviarle un recordatorio de cobranza por correo. `null` =
   * cuenta sin contacto de correo capturado todavía — sigue siendo una cuenta
   * por cobrar válida (mismo criterio "honesto" que `citas.customer.email is
   * null`, ver `cobranza/email-notifications.ts`), simplemente no recibe
   * recordatorio por correo hasta que alguien lo capture. */
  readonly clienteNombre: string | null;
  readonly clienteEmail: string | null;
  readonly createdAt: string;
}

export interface NewReceivableInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly fechaVencimiento: string;
  /** Opcionales (migración 005) — ver nota de `ReceivableRecord`. */
  readonly clienteNombre?: string | null;
  readonly clienteEmail?: string | null;
}

/** Etapa de un evento de cobranza — las 5 etapas de la secuencia de
 * recordatorios (ver `cobranza/templates.ts`) más 'respuesta' (port de
 * `register_response`, cuando el deudor contesta fuera de la secuencia
 * automática). */
export type CollectionEventStage = CobranzaReminderStage | "respuesta";
export type CollectionEventChannel = "email" | "whatsapp";

/** Registro de auditoría de un recordatorio generado (o de una respuesta del
 * deudor) — port de `collection_events`. Alimenta `scoreCobrabilidadCartera`
 * (ver `cobranza/engine.ts`) como historial. */
export interface CollectionEventRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly receivableId: string;
  readonly etapa: CollectionEventStage;
  readonly canal: CollectionEventChannel;
  readonly respuesta: string | null; // p.ej. 'pagado' | 'promesa_pago', null si aún sin respuesta
  readonly createdAt: string;
}

export interface NewCollectionEventInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly receivableId: string;
  readonly etapa: CollectionEventStage;
  readonly canal: CollectionEventChannel;
  readonly respuesta: string | null;
}

/**
 * Fila que devuelve `DespachosRepository.systemListPendingReceivablesForReminders`
 * -- combina, para UNA property, la cartera pendiente (`receivable`) con el folio
 * fiscal/total del `invoice` asociado (antes exigía un `findInvoice` aparte por
 * cada fila) -- exclusiva del barrido de sistema
 * (`apps/worker/src/jobs/despachos/cobranza-reminders.ts`, ver
 * `despachos.system_list_pending_receivables_with_invoice`, migración 009). El
 * staff sigue usando `listReceivables`/`findInvoice` por separado, sin cambio.
 */
export interface ReceivableReminderRow {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly fechaVencimiento: string;
  readonly clienteNombre: string | null;
  readonly clienteEmail: string | null;
  readonly facturaFolioFiscal: string;
  readonly facturaTotal: number;
}

/** Input de `DespachosRepository.systemRecordCollectionEvent` -- igual que
 * `NewCollectionEventInput` más `eventDate` (fecha de negocio del barrido,
 * `YYYY-MM-DD` -- inyectada por el caller, nunca `now()` interno, para que el
 * dedupe sea determinista en pruebas). Exclusivo del barrido de sistema. */
export interface NewSystemCollectionEventInput extends NewCollectionEventInput {
  readonly eventDate: string;
}

/** Fila de `despachos.audit_log` (008_despachos_audit_log.sql), ya mapeada a
 * camelCase -- ver `DespachosRepository.listAuditLogPage` (f2-orden-total-bitacoras).
 * `payload` es el `AuthzAuditEntry` completo tal cual lo guardó
 * `ProductionDespachosAuditSink` (nunca reinterpretado aquí). */
export interface DespachosAuditLogEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

/** Página de `DespachosRepository.listAuditLogPage` -- mismo shape que
 * `InvoicePage`/`RentasAuditLogPagina` (@atiende/domain-rentas). */
export interface DespachosAuditLogPage {
  readonly items: readonly DespachosAuditLogEntry[];
  readonly total: number;
  readonly nextOffset: number | null;
}
