// lib/contract-billing-client.ts — cobranza post-adjudicación (Fase 15 pieza
// 1, hallazgo ALTA "Post-adjudicación completa... = 22 rutas sin UI"):
// `contractBilling.ts` expone POST/GET .../contract/invoices, POST
// .../contract/invoices/:invoiceId/mark-paid y GET .../contract/receivables
// -- ninguno tenía cliente ni página. El vencimiento de cada factura SIEMPRE
// lo calcula el servidor (`computePaymentDueDate`, Art. 73 LAASSP, 17 días
// hábiles) -- este cliente nunca declara `dueDate`. El monto SIEMPRE viaja
// como cadena decimal (`DecimalString`, `money.ts::assertValidDecimalString`)
// -- nunca un `number` de punto flotante.
//
// Requiere un contrato YA registrado para esta convocatoria (`POST
// .../contract`, `contracts.ts`) -- alta de contrato/documentos/autopsia/
// renovaciones queda deliberadamente FUERA de esta pieza (ver README del
// vertical, alcance de otra pieza/ronda). Un 404 "regístrelo primero con
// POST .../contract" se propaga tal cual del servidor -- esta pantalla no
// ofrece crear el contrato, solo lo explica.
import { fetchJson, postJson } from "./admin-client.ts";

export type ContractInvoiceStatus = "pendiente" | "pagada" | "vencida";

/** Espejo de `ContractInvoiceRecord` (`domain-licitaciones/repository.ts`) tal cual lo serializa `contractBilling.ts` -- `amount` es SIEMPRE `DecimalString`, nunca `number`. */
export interface ContractInvoiceRecord {
  readonly id: string;
  readonly contractId: string;
  readonly concepto: string;
  readonly amount: string;
  readonly invoiceVerifiedOn: string;
  readonly dueDate: string;
  readonly legalReference: string;
  readonly paidAt: string | null;
  readonly status: ContractInvoiceStatus;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Espejo de `ReceivablesSummary` -- `totalPending`/`totalOverdue` en Decimal (sumados en centavos server-side, `money.ts::sumCents`), nunca sumados aquí. `totalOverdue` es un SUBCONJUNTO informativo de `totalPending`, nunca se restan entre sí. */
export interface ReceivablesSummary {
  readonly asOfDate: string;
  readonly totalPending: string;
  readonly totalOverdue: string;
  readonly countPending: number;
  readonly countOverdue: number;
  readonly invoices: readonly ContractInvoiceRecord[];
}

export interface CreateInvoiceInput {
  readonly concepto: string;
  /** Cadena decimal, p. ej. "12345.67" -- validada server-side (`assertValidDecimalString`). */
  readonly amount: string;
  /** "YYYY-MM-DD" -- fecha en que se verificó la factura; el vencimiento (17 días hábiles, Art. 73 LAASSP) lo calcula el servidor a partir de esta fecha, nunca el cliente. */
  readonly invoiceVerifiedOn: string;
}

/** Marcador explícito del 404 "sin contrato" de `requireContract` en `contractBilling.ts`, para que la página lo distinga de cualquier otro error y muestre la explicación correcta en vez de un mensaje genérico. */
export class ContractNotFoundError extends Error {}

async function withContractNotFoundMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && /No existe contrato registrado/.test(err.message)) {
      throw new ContractNotFoundError(err.message);
    }
    throw err;
  }
}

/** `GET .../contract/invoices` -- lectura, ningún rol restringido en el servidor. */
export async function fetchContractInvoices(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly ContractInvoiceRecord[]> {
  return withContractNotFoundMapping(async () => {
    const body = await fetchJson<{ invoices: readonly ContractInvoiceRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/invoices`, token);
    return body.invoices;
  });
}

/** `POST .../contract/invoices` -- WRITE_ROLES en el servidor; esta función no valida rol, solo transporta. */
export async function createContractInvoice(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: CreateInvoiceInput,
): Promise<ContractInvoiceRecord> {
  return withContractNotFoundMapping(() => postJson<ContractInvoiceRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/invoices`, token, input));
}

/** `POST .../contract/invoices/:invoiceId/mark-paid` -- WRITE_ROLES. Una factura inexistente llega aquí como error normal (404 del servidor), nunca se silencia. */
export async function markContractInvoicePaid(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  invoiceId: string,
): Promise<ContractInvoiceRecord> {
  return withContractNotFoundMapping(() =>
    postJson<ContractInvoiceRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/invoices/${invoiceId}/mark-paid`, token, {}),
  );
}

/** `GET .../contract/receivables` -- lectura, ningún rol restringido. El resumen SIEMPRE se recalcula contra la fecha de hoy (`classifyInvoiceStatus`), nunca contra un `status` persistido. */
export async function fetchReceivablesSummary(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ReceivablesSummary> {
  return withContractNotFoundMapping(() => fetchJson<ReceivablesSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/receivables`, token));
}
