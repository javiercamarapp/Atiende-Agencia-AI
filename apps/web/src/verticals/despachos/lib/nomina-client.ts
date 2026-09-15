// Cliente de nómina (hallazgo de auditoría severidad ALTA, "Siete módulos con ruta
// HTTP real y sin UI" -- siguiente porción tras vencimientos y declaraciones):
// nomina.ts expone POST /despachos/:propertyId/nomina/calcular y
// POST /despachos/:propertyId/nomina/generar-xml (apps/api/.../despachos/nomina.ts),
// pero ningún cliente web ni página los usaba. Mismo motivo que el resto de
// lib/*.ts de este panel: separado de pages/Nomina.tsx para poder probarlo con
// vitest en entorno "node" sin DOM.
//
// Ambos endpoints son PUROS/sin persistencia (ver comentario de nomina.ts): el
// resultado no se guarda aquí -- es responsabilidad de quien use el panel copiar
// el desglose o el XML generado donde corresponda. `generar-xml` reusa
// INTERNAMENTE el mismo motor que `calcular` (nunca acepta cifras ya calculadas
// desde el cliente para el XML fiscal), por eso esta página siempre llama a
// `calcularNomina` antes de `generarXmlNomina` -- para mostrar el desglose y
// dejar que el usuario confirme antes de generar el XML.
import { postJson } from "./admin-client.ts";

export interface PayrollPeriodInputBody {
  readonly month?: number;
  readonly year?: number;
  readonly diasPagados?: number;
  readonly salarioDiarioDefault?: number;
}

export interface EmployeePayrollInputBody {
  readonly employeeId?: string;
  readonly nombre?: string;
  readonly salarioBruto?: number;
  readonly percepciones?: number;
  readonly salarioDiario?: number;
}

export interface PayrollTaxes {
  readonly isr: number;
  readonly imssPatronal: number;
  readonly imssObrero: number;
  readonly infonavit: number;
  readonly total: number;
}

export interface EmployeePayroll {
  readonly employeeId: string;
  readonly nombre: string;
  readonly salarioDiario: number;
  readonly salarioBruto: number;
  readonly percepciones: number;
  readonly deducciones: number;
  readonly taxes: PayrollTaxes;
  readonly neto: number;
  readonly diasPagados: number;
}

export interface PayrollPeriodResultado {
  readonly month: number;
  readonly year: number;
  readonly employees: readonly EmployeePayroll[];
  readonly totalBruto: number;
  readonly totalNeto: number;
  readonly totalDeducciones: number;
  readonly totalIsr: number;
  readonly totalImssPatronal: number;
  readonly totalImssObrero: number;
  readonly totalInfonavit: number;
  readonly tenantId: number | null;
  readonly requiresHumanReview: boolean;
  readonly humanReviewReason: string;
  readonly referenciaLegal: string;
  readonly supuesto: string;
  readonly idempotencyKey: string;
}

export async function calcularNomina(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly period: PayrollPeriodInputBody; readonly employees: readonly EmployeePayrollInputBody[]; readonly tenantId?: number | null },
): Promise<PayrollPeriodResultado> {
  return postJson<PayrollPeriodResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/nomina/calcular`, token, input);
}

/** Tipo de nómina del complemento CFDI 1.2 -- "O" (ordinaria) o "E" (extraordinaria),
 * mismo catálogo que TIPOS_NOMINA (@atiende/domain-despachos/nomina/xml-nomina.ts). */
export type TipoNomina = "O" | "E";

export interface EmisorXmlNominaBody {
  readonly rfc: string;
  readonly nombre: string;
  readonly regimenFiscal: string;
  readonly lugarExpedicion: string;
  readonly noCertificado?: string;
  readonly certificado?: string;
}

export interface EmployeeXmlNominaBody extends EmployeePayrollInputBody {
  readonly rfcReceptor: string;
  readonly nombreReceptor?: string;
  readonly domicilioFiscalReceptor: string;
  readonly regimenFiscalReceptor?: string;
  readonly folio: string;
}

export interface GenerarXmlNominaInput {
  readonly period: PayrollPeriodInputBody & { readonly tipoNomina?: TipoNomina; readonly serie?: string };
  readonly employees: readonly EmployeeXmlNominaBody[];
  readonly emisor: EmisorXmlNominaBody;
  readonly tenantId?: number | null;
}

export interface ComprobanteNomina {
  readonly employeeId: string;
  readonly folio: string;
  readonly xml: string;
}

export interface GenerarXmlNominaResultado {
  readonly idempotencyKey: string;
  readonly comprobantes: readonly ComprobanteNomina[];
}

export async function generarXmlNomina(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: GenerarXmlNominaInput,
): Promise<GenerarXmlNominaResultado> {
  return postJson<GenerarXmlNominaResultado>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/nomina/generar-xml`, token, input);
}
