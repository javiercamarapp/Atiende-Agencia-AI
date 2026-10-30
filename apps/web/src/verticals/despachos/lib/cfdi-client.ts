// Lógica de datos de CFDI emitidos/recibidos (Fase 9) — separada de
// pages/Cfdi*.tsx a propósito, mismo motivo que el resto de lib/*.ts de este panel.
// Llama a `GET /despachos/:propertyId/cfdi(?requiereRevisionHumana=)` y
// `GET /despachos/:propertyId/cfdi/:invoiceId` (apps/api/.../despachos/cfdi.ts,
// `serializeInvoice`) — la validación fiscal real (billing + reglas SAT avanzadas)
// vive por completo en @atiende/domain-despachos; este cliente solo transporta lo
// que la ruta ya serializa.
import { fetchJson, postJson, postXml, putJson } from "./admin-client.ts";

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

/** Sentido del CFDI respecto del RFC del cliente (ficha de cartera). `indeterminado` = sin ficha o sin relacion con el cliente. */
export type DireccionCfdi = "emitido" | "recibido" | "indeterminado";
export type EstadoSatCfdi = "pendiente" | "vigente" | "cancelado" | "no_encontrado";

export interface MontosCentavos {
  readonly subtotal: number | null;
  readonly descuento: number | null;
  readonly total: number | null;
  readonly ivaTrasladado: number | null;
  readonly isrRetenido: number | null;
  readonly ivaRetenido: number | null;
  readonly ieps: number | null;
}

export interface ImpuestoDesglosado {
  readonly naturaleza: "traslado" | "retencion";
  readonly impuesto: string;
  readonly nombre: string;
  readonly tipoFactor: "Tasa" | "Cuota" | "Exento";
  readonly tasaOCuota: string | null;
  readonly baseCentavos: number | null;
  readonly importeCentavos: number | null;
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
  readonly fecha?: string;
  readonly creadoEn: string;
  // D-22: `null`/ausente = dato que el CFDI no trajo o que se ingirio antes de la migracion (jamas un 0 inventado).
  readonly direccion?: DireccionCfdi | null;
  readonly metodoPago?: string | null;
  readonly formaPago?: string | null;
  readonly usoCfdi?: string | null;
  readonly moneda?: string | null;
  readonly tipoCambio?: number | null;
  readonly montosCentavos?: MontosCentavos;
  readonly estadoSat?: EstadoSatCfdi;
  readonly estadoSatVerificadoEn?: string | null;
  /** Lo que el SAT responde sobre la cancelacion (paridad3 D-P3-19; `null` = aun no consultado o base sin la migracion 027). */
  readonly esCancelable?: string | null;
  readonly estatusCancelacion?: string | null;
  readonly codigoEstatus?: string | null;
  readonly validacionEfos?: string | null;
  /** Solo en el detalle (`GET .../cfdi/:invoiceId`). */
  readonly impuestos?: readonly ImpuestoDesglosado[];
}

export async function fetchInvoices(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  filter?: { readonly requiereRevisionHumana?: boolean; readonly direccion?: DireccionCfdi },
): Promise<readonly InvoiceSummary[]> {
  const params = new URLSearchParams();
  if (filter?.requiereRevisionHumana !== undefined) params.set("requiereRevisionHumana", String(filter.requiereRevisionHumana));
  if (filter?.direccion !== undefined) params.set("direccion", filter.direccion);
  const qs = params.toString() === "" ? "" : `?${params.toString()}`;
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

/** `PUT /despachos/:propertyId/cfdi/:invoiceId/estado-sat` -- captura el estado del CFDI ante el SAT (un cancelado no cambia). */
export async function registrarEstadoSat(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, invoiceId: string, estado: EstadoSatCfdi): Promise<InvoiceSummary> {
  return putJson<InvoiceSummary>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cfdi/${invoiceId}/estado-sat`, token, { estado });
}

/** Resultado de `POST .../cfdi/:invoiceId/verificar-estatus-sat` (D-27). `consultado: false` = el SAT no respondio (o el CFDI ya estaba
 * cancelado): el estado NO cambia y `motivo` dice por que. */
export interface VerificacionEstatusSat {
  readonly consultado: boolean;
  readonly motivo?: "datos_insuficientes" | "timeout" | "red" | "http" | "respuesta_invalida" | "ya_cancelado";
  readonly estadoSat: EstadoSatCfdi;
  readonly estadoSatVerificadoEn: string | null;
  readonly esCancelable: string | null;
  readonly estatusCancelacion: string | null;
  readonly codigoEstatus?: string | null;
  readonly validacionEfos?: string | null;
}

/** `POST /despachos/:propertyId/cfdi/:invoiceId/verificar-estatus-sat` -- consulta el estatus del CFDI ante el servicio publico del SAT. */
export async function verificarEstatusSat(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, invoiceId: string): Promise<VerificacionEstatusSat> {
  return postJson<VerificacionEstatusSat>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cfdi/${invoiceId}/verificar-estatus-sat`, token, {});
}
