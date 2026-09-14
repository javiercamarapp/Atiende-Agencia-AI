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
  readonly createdAt: string;
}

export interface NewReceivableInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly invoiceId: string;
  readonly fechaVencimiento: string;
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
