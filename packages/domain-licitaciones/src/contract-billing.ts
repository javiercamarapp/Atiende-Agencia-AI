// contract-billing.ts — Fase 6 pieza 1, ítem 2 (REQ-051 "agente de
// cobranza"): seguimiento determinista de pagos pendientes contra un
// contrato. Port ~literal de la referencia legal verificada en el repo
// original (`licitaciones/apps/api/src/lib/expediente/business-days.ts`,
// `docs/legal/verificacion-legal.md` fila REQ-105): la LAASSP vigente (DOF
// 16-abr-2025) fija en su Art. 73 el plazo de pago en 17 días HÁBILES desde
// la verificación de la factura (no 20 días naturales, que era el régimen
// de la ley abrogada). REQ-050 (versionar el régimen legal por fecha de
// CONVOCATORIA — LAASSP nueva vs. LAASSP 2000 abrogada) queda
// explícitamente FUERA de esta pieza: se aplica siempre el régimen VIGENTE
// hoy (17 días hábiles), documentado como una simplificación deliberada
// (ver README del vertical) — construir el versionado completo por fecha de
// convocatoria es trabajo aparte de REQ-050 que esta fase no cubre.
//
// Dinero SIEMPRE en `DecimalString`/centavos vía `money.ts` (REQ-051:
// "dinero en Decimal... nunca por LLM") — nunca `number` de punto flotante.
// El vencimiento SIEMPRE lo calcula este motor determinista a partir de la
// fecha de verificación de la factura declarada por el usuario — nunca lo
// decide el cliente ni un LLM.
import { addBusinessDays, CALENDAR_LIMITATION_NOTE } from "./business-days.ts";
import { fromCents, sumCents, toCents, type DecimalString } from "./money.ts";

export const LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS = 17;
export const LAASSP_ART_73_LEGAL_REFERENCE =
  'LAASSP nueva, Art. 73 (DOF 16-abr-2025, vigor 17-abr-2025): pago dentro de los 17 días hábiles siguientes a la verificación de la factura. REQ-050 (versionar por fecha de convocatoria contra el régimen abrogado, 20 días naturales) no está construido en esta fase -- se aplica siempre el régimen vigente hoy.';

export interface PaymentDeadlineResult {
  readonly dueDate: string;
  readonly businessDays: number;
  readonly legalReference: string;
  readonly calendarNote: string;
}

/** Calcula la fecha límite de pago (17 días hábiles desde la verificación de la factura, Art. 73 LAASSP nueva). `holidays` opcional, mismo criterio fail-closed que `business-days.ts`. */
export function computePaymentDueDate(invoiceVerifiedOnIsoDate: string, holidays: readonly string[] = []): PaymentDeadlineResult {
  const dueDate = addBusinessDays(invoiceVerifiedOnIsoDate, LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS, holidays);
  return { dueDate, businessDays: LAASSP_ART_73_PAYMENT_TERM_BUSINESS_DAYS, legalReference: LAASSP_ART_73_LEGAL_REFERENCE, calendarNote: CALENDAR_LIMITATION_NOTE };
}

export type ContractInvoiceStatus = "pendiente" | "pagada" | "vencida";

export interface InvoiceStatusInput {
  readonly dueDate: string; // "YYYY-MM-DD"
  readonly paidAt: string | null; // ISO 8601, o null si no se ha registrado el pago
}

/**
 * Clasifica una factura contra la fecha de hoy, NUNCA contra la fecha en
 * que se creó -- una factura "pendiente" se vuelve "vencida" en cuanto pasa
 * `dueDate` sin `paidAt` registrado, se recalcula en cada lectura (nunca se
 * confía en un campo `status` persistido que pueda quedar obsoleto).
 *
 * `todayIsoDate` es OBLIGATORIO a propósito (bug real, revisión r6 de PR
 * #171): esta función tenía un default `new Date().toISOString().slice(0,
 * 10)` -- el día UTC del proceso, no el día de negocio -- y
 * `postgres-repository.ts::mapContractInvoice` lo dejó colarse sin pasar
 * fecha, mientras `receivablesSummary` en el MISMO archivo sí calculaba con
 * `@atiende/core-tenancy::hoyFechaNegocio()`. Resultado: entre las 18:00 y
 * las 23:59 CDMX, una factura que vencía HOY salía "vencida" en
 * `invoices[]` pero `countOverdue: 0` en los totales de la misma respuesta.
 * Quitar el default obliga a todo caller (Postgres, in-memory, tests) a
 * declarar explícitamente qué "hoy" usa, para que este bug no se vuelva a
 * colar en un call-site nuevo.
 */
export function classifyInvoiceStatus(input: InvoiceStatusInput, todayIsoDate: string): ContractInvoiceStatus {
  if (input.paidAt !== null) return "pagada";
  const today = todayIsoDate.slice(0, 10);
  return today > input.dueDate ? "vencida" : "pendiente";
}

export interface ReceivableLineInput extends InvoiceStatusInput {
  readonly amount: DecimalString;
}

export interface ReceivablesTotals {
  readonly totalPending: DecimalString;
  readonly totalOverdue: DecimalString;
  readonly countPending: number;
  readonly countOverdue: number;
}

/**
 * Suma en centavos (nunca `number` flotante, REQ-051) el monto pendiente y
 * el monto vencido de un conjunto de facturas -- "pendiente" incluye tanto
 * facturas todavía dentro de plazo como vencidas (el total vencido es un
 * SUBCONJUNTO informativo del pendiente, nunca se restan entre sí).
 */
export function summarizeReceivables(invoices: readonly ReceivableLineInput[], todayIsoDate: string): ReceivablesTotals {
  const pending: bigint[] = [];
  const overdue: bigint[] = [];
  let countPending = 0;
  let countOverdue = 0;
  for (const invoice of invoices) {
    const status = classifyInvoiceStatus(invoice, todayIsoDate);
    if (status === "pagada") continue;
    const cents = toCents(invoice.amount);
    pending.push(cents);
    countPending += 1;
    if (status === "vencida") {
      overdue.push(cents);
      countOverdue += 1;
    }
  }
  return {
    totalPending: fromCents(sumCents(pending)),
    totalOverdue: fromCents(sumCents(overdue)),
    countPending,
    countOverdue,
  };
}
