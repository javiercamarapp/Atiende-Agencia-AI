// Lógica de datos de CFDI de hospedaje (Fase 5, H5/REQ-BO-001/002) — consume
// apps/api/src/routes/verticals/hoteles/cfdi.ts (`serializeCfdi`). A diferencia de
// despachos/lib/cfdi-client.ts (lectura pura de un comprobante YA timbrado por un
// tercero), aquí NUESTRO hotel es el emisor: este cliente cubre timbrar/pagar/
// cancelar, todas operaciones de escritura de dinero/cumplimiento fiscal que exigen
// `Idempotency-Key` (mismo criterio que folios-client.ts). El motor de reglas
// fiscales (breakdown ISH/DSA, validación previa al timbrado) corre siempre en el
// servidor — este cliente nunca calcula ni valida montos por su cuenta, solo
// transporta lo que la ruta ya serializa.
import { fetchJson, sendJson } from "./admin-client.ts";

export type CfdiEmisionTipo = "hospedaje" | "pago";
export type CfdiEmisionEstado = "pendiente" | "timbrado" | "en_proceso_cancelacion" | "cancelado" | "rechazado";

export interface CfdiEmisionSummary {
  readonly id: string;
  readonly folioId: string;
  readonly tipo: CfdiEmisionTipo;
  readonly uuidFiscal: string | null;
  readonly estado: CfdiEmisionEstado;
  readonly pac: string | null;
  readonly subtotal: number;
  readonly iva: number;
  readonly impuestosLocales: { readonly ishTasa: number; readonly ishMonto: number; readonly dsaMonto: number };
  readonly total: number;
  readonly rfcReceptor: string;
  readonly usoCfdi: string;
  readonly metodoPago: string;
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
  readonly relacionadoCfdiId: string | null;
  readonly creadoEn: string;
  readonly canceladoEn: string | null;
}

/** `GET /hoteles/:propertyId/cfdi` — listado completo de la property (todas las
 * facturas de todos los folios), sin usar por la página de folio hoy pero expuesto
 * para el futuro listado a nivel property (ver comentario de cabecera de
 * `hotelesCfdiRoutes`: es la 1ra de las 4 rutas reales). */
export async function fetchCfdisByProperty(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CfdiEmisionSummary[]> {
  return fetchJson<readonly CfdiEmisionSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/cfdi`, token);
}

/** `GET /hoteles/:propertyId/folios/:folioId/cfdi` — los CFDI (hospedaje + sus
 * complementos de pago) de UN folio — lo que consume la página de CFDI del folio. */
export async function fetchCfdisByFolio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string): Promise<readonly CfdiEmisionSummary[]> {
  return fetchJson<readonly CfdiEmisionSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cfdi`, token);
}

export interface EmitirHospedajeInput {
  /** Omitidos cuando `esExtranjero`/`esGlobal` es true — el servidor resuelve el RFC
   *  genérico correspondiente (ver `resolveReceptorHospedaje`), nunca se inventa uno
   *  aquí en el cliente. */
  readonly rfcReceptor?: string;
  readonly usoCfdi?: string;
  readonly metodoPago: "PUE" | "PPD";
  readonly esExtranjero: boolean;
  readonly esGlobal: boolean;
  readonly esNoShow: boolean;
}

/** `POST /hoteles/:propertyId/folios/:folioId/cfdi` — timbra el CFDI de hospedaje del
 * folio (idempotente por folio+tipo del lado del servidor: reintentar devuelve el
 * mismo UUID, 200 en vez de 201). Aplicación de anticipo (`esAplicacionAnticipo`/
 * `cfdiRelacionados`/`tipoRelacion`) queda fuera de este formulario — REQ-BO-002
 * cubre el caso simple (un CFDI de hospedaje por folio); relacionar contra un
 * anticipo previo es un flujo administrativo distinto, no pedido en esta página. */
export async function emitirCfdiHospedaje(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, input: EmitirHospedajeInput, idempotencyKey: string): Promise<CfdiEmisionSummary> {
  return sendJson<CfdiEmisionSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cfdi`, token, "POST", input, idempotencyKey);
}

/** `POST /hoteles/:propertyId/folios/:folioId/cfdi/pago` — complemento de pago (tipo
 * 'pago') sobre un CFDI de hospedaje PPD ya timbrado, referenciando el pago
 * `capturado` del folio que lo liquida. Idempotente por pago del lado del servidor. */
export async function emitirCfdiPago(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, folioId: string, paymentId: string, relacionadoCfdiId: string, idempotencyKey: string): Promise<CfdiEmisionSummary> {
  return sendJson<CfdiEmisionSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/folios/${folioId}/cfdi/pago`, token, "POST", { paymentId, relacionadoCfdiId }, idempotencyKey);
}

export type MotivoCancelacionSat = "01" | "02" | "03" | "04";

export const MOTIVO_CANCELACION_LABELS: Record<MotivoCancelacionSat, string> = {
  "01": "01 · Comprobante emitido con errores, con relación",
  "02": "02 · Comprobante emitido con errores, sin relación",
  "03": "03 · No se llevó a cabo la operación",
  "04": "04 · Operación nominativa relacionada en factura global",
};

/** `POST /hoteles/:propertyId/cfdi/:cfdiId/cancelar` — cancela ante el PAC con el
 * motivo del catálogo SAT `c_MotivoCancelacion`. `folioSustitucion` solo aplica al
 * motivo "01" (relación con el CFDI que lo sustituye) — el servidor no lo exige por
 * motivo, se envía tal cual lo capture el usuario. */
export async function cancelarCfdi(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, cfdiId: string, motivo: MotivoCancelacionSat, folioSustitucion: string | undefined, idempotencyKey: string): Promise<{ id: string; estado: string }> {
  const body: { motivo: MotivoCancelacionSat; folioSustitucion?: string } = { motivo };
  if (folioSustitucion) body.folioSustitucion = folioSustitucion;
  return sendJson<{ id: string; estado: string }>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/cfdi/${cfdiId}/cancelar`, token, "POST", body, idempotencyKey);
}
