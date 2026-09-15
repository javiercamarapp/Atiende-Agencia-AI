// Lógica de datos de CFDI emitidos/recibidos (Fase 9) — separada de
// pages/Cfdi*.tsx a propósito, mismo motivo que el resto de lib/*.ts de este panel.
// Llama a `GET /despachos/:propertyId/cfdi(?requiereRevisionHumana=)` y
// `GET /despachos/:propertyId/cfdi/:invoiceId` (apps/api/.../despachos/cfdi.ts,
// `serializeInvoice`) — la validación fiscal real (billing + reglas SAT avanzadas)
// vive por completo en @atiende/domain-despachos; este cliente solo transporta lo
// que la ruta ya serializa.
import { fetchJson, postXml } from "./admin-client.ts";

export type TipoComprobante = "I" | "E" | "T" | "P" | "N";
export type CategoriaContable = "gasto_operativo" | "activo_fijo" | "inversion" | "honorarios" | "nomina" | "sin_clasificar";

export interface HallazgoCfdi {
  readonly codigo: string;
  readonly mensaje: string;
  readonly ref?: string;
}

export interface ProveedorReportableDiot {
  readonly rfc: string;
  readonly periodo: string;
  readonly [key: string]: unknown;
}

export interface DiotResult {
  readonly proveedoresReportables: readonly ProveedorReportableDiot[];
  readonly reportable: boolean;
}

export interface InvoiceSummary {
  readonly id: string;
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
  readonly requiereRevisionHumana: boolean;
  readonly diot: DiotResult;
  readonly creadoEn: string;
}

export async function fetchInvoices(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filter?: { readonly requiereRevisionHumana?: boolean }): Promise<readonly InvoiceSummary[]> {
  const qs = filter?.requiereRevisionHumana !== undefined ? `?requiereRevisionHumana=${filter.requiereRevisionHumana}` : "";
  return fetchJson<readonly InvoiceSummary[]>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cfdi${qs}`, token);
}

export async function fetchInvoice(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, invoiceId: string): Promise<InvoiceSummary> {
  return fetchJson<InvoiceSummary>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cfdi/${invoiceId}`, token);
}

/** `POST /despachos/:propertyId/cfdi/importar-xml` (apps/api/.../despachos/cfdi.ts)
 * -- recibe el XML crudo de un CFDI 4.0 timbrado y lo hace pasar por el MISMO
 * motor de validación/ingesta que `POST /cfdi` (ver `ingestarCfdiDespachos` en
 * esa ruta); este cliente solo transporta el texto del XML tal cual, sin tocarlo. */
export async function importarCfdiXml(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, xml: string): Promise<InvoiceSummary> {
  return postXml<InvoiceSummary>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cfdi/importar-xml`, token, xml, "application/xml");
}
