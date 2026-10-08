// Tipos de registro (fila ya mapeada a camelCase) que DespachosRepository devuelve/
// recibe — ninguna función de negocio de las rutas de apps/api toca una fila cruda de
// SQL directamente, mismo criterio que domain-hoteles/src/types.ts y
// domain-restaurantes/src/types.ts.
import type { HallazgoCfdi } from "@atiende/billing";
import type { DiotResult } from "./cfdi/reglas-fiscales-avanzadas.ts";
import type { EstadoVencimiento, NivelEscalamiento, PrioridadVencimiento, TipoVencimiento } from "./vencimientos/engine.ts";
import type { CobranzaReminderStage } from "./cobranza/templates.ts";
import type { DireccionCfdi, EstadoSatCfdi, ImpuestoCfdiInput } from "./cfdi/modelo-cfdi.ts";

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
  // ---- D-22 (migración 018): modelo CFDI completo. Opcionales a propósito (los literales de `InvoiceRecord` de otros módulos/pruebas siguen compilando); ausente o `null` = dato desconocido (CFDI ingerido antes de la migración
  // o con la base sin migrar), jamás un 0 inventado. Los montos en centavos son enteros; `subtotal`/`total`/... (pesos,
  // numeric(14,2)) siguen siendo la fuente de los reportes existentes.
  /** Sentido del CFDI respecto del RFC del cliente (ficha de cartera): emitido / recibido / indeterminado. */
  readonly direccion?: DireccionCfdi | null;
  readonly metodoPago?: string | null;
  readonly formaPago?: string | null;
  readonly usoCfdi?: string | null;
  readonly moneda?: string | null;
  readonly tipoCambio?: number | null;
  readonly subtotalCentavos?: number | null;
  readonly descuentoCentavos?: number | null;
  readonly totalCentavos?: number | null;
  readonly ivaTrasladadoCentavos?: number | null;
  readonly isrRetenidoCentavos?: number | null;
  readonly ivaRetenidoCentavos?: number | null;
  readonly iepsCentavos?: number | null;
  /** Estado del comprobante ante el SAT. `pendiente` = nunca verificado (default); lo captura el staff. */
  readonly estadoSat?: EstadoSatCfdi;
  readonly estadoSatVerificadoEn?: string | null;
  /** paridad3 D-P3-19: detalle de cancelacion que devuelve el SAT (027). `undefined`/`null` = nunca consultado o base sin migrar. */
  readonly esCancelable?: string | null;
  readonly estatusCancelacion?: string | null;
  readonly codigoEstatus?: string | null;
  readonly validacionEfos?: string | null;
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
  // ---- D-22 (opcionales: el camino anterior de la ingesta no los manda y la base sin migrar los ignora) ----
  readonly direccion?: DireccionCfdi | null;
  readonly metodoPago?: string | null;
  readonly formaPago?: string | null;
  readonly usoCfdi?: string | null;
  readonly moneda?: string | null;
  readonly tipoCambio?: number | null;
  readonly subtotalCentavos?: number | null;
  readonly descuentoCentavos?: number | null;
  readonly totalCentavos?: number | null;
  readonly ivaTrasladadoCentavos?: number | null;
  readonly isrRetenidoCentavos?: number | null;
  readonly ivaRetenidoCentavos?: number | null;
  readonly iepsCentavos?: number | null;
  /** Desglose de impuestos por (naturaleza, impuesto, factor, tasa); se persiste en la misma operación que el invoice. */
  readonly impuestos?: readonly ImpuestoCfdiInput[];
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

/** Fila de `despachos.property_config` (migración 012, FASE 3 producto -- zona
 * horaria por negocio), ya mapeada a camelCase. `zonaHoraria` es `null` cuando la
 * property nunca configuró una zona real todavía (fila ausente) -- el caller SIEMPRE
 * resuelve el default de plataforma vía
 * `@atiende/core-tenancy::resolverZonaHorariaNegocio(config?.zonaHoraria)`, nunca
 * hardcodea `"America/Mexico_City"` directo (ver el comentario de cabecera de esa
 * función). */
export interface DespachosPropertyConfigRecord {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly zonaHoraria: string | null;
}
