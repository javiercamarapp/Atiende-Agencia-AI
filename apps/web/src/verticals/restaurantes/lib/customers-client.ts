// Lógica de datos de Clientes (Fase 5) — listado/búsqueda + ficha real sobre
// apps/api/src/routes/verticals/restaurantes/admin-customers.ts. Nunca inventa
// campos: la ficha es exactamente el mismo shape que
// `@atiende/domain-restaurantes::CustomerLookupResult` (tier real, "lo de siempre"
// real, direcciones guardadas).
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export interface CustomerSummary {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string;
  readonly orderCount: number;
  /** Migracion 054; `null` si la base aun no la tiene o no hay datos suficientes. */
  readonly tier: CustomerTier | null;
  readonly lastOrderAt: string | null;
}

export interface CustomerListPage {
  readonly customers: readonly CustomerSummary[];
  readonly nextCursor: string | null;
  /** `false` = se pidio un filtro de cartera y la base aun no tiene la migracion 054 (lista vacia + estado "no disponible aun"). */
  readonly filtrosDisponibles: boolean;
}

export async function fetchCustomers(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { search?: string; limit?: number; cursor?: string } & CarteraFiltros = {},
): Promise<CustomerListPage> {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
  if (opts.nivel) params.set("nivel", opts.nivel);
  if (opts.frecuencia) params.set("frecuencia", opts.frecuencia);
  if (opts.inactivoDias) params.set("inactivoDias", String(opts.inactivoDias));
  if (opts.branchId) params.set("branchId", opts.branchId);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return fetchJson<CustomerListPage>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers${qs ? `?${qs}` : ""}`, token);
}

export type CustomerTier = "BLACK" | "PLATINUM" | "GOLD" | "BLUE";

export interface CustomerAddress {
  readonly address: string;
  readonly label: string | null;
  readonly isDefault: boolean;
}

export interface OrderHistoryItem {
  readonly name: string;
  readonly quantity: number;
}

export type CustomerDetail =
  | { readonly isNew: true }
  | {
      readonly isNew: false;
      readonly name: string | null;
      readonly orderCount: number;
      readonly addresses: readonly CustomerAddress[];
      readonly lastOrderItems: readonly OrderHistoryItem[] | null;
      readonly frequentItems: readonly OrderHistoryItem[];
      readonly tier: CustomerTier | null;
      readonly agentNotes: readonly string[];
      /** Nota interna (migracion 054, p. ej. la de una importacion de cartera); `null` si no hay. */
      readonly notes?: string | null;
    };

export async function fetchCustomerDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<CustomerDetail> {
  const body = await fetchJson<{ customer: CustomerDetail }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers/${customerId}`, token);
  return body.customer;
}

// ---- Cliente 360 (migracion 049): ficha completa del cliente ----

export type TipoGusto = "tortilla" | "salsa" | "omision" | "nota" | "pago" | "propina" | "canal" | "sucursal";

export const ETIQUETA_TIPO_GUSTO: Readonly<Record<TipoGusto, string>> = {
  tortilla: "Tortilla",
  salsa: "Salsa",
  omision: "Sin (omite)",
  nota: "Nota recurrente",
  pago: "Forma de pago",
  propina: "Propina habitual",
  canal: "Canal",
  sucursal: "Sucursal",
};

export interface DomicilioFicha {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly accessNotes: string | null;
  readonly mapsUrl: string | null;
  readonly colonia: string | null;
  readonly branchSlug: string | null;
  readonly lastUsedAt: string | null;
  readonly timesUsed: number;
}

export interface GustoFicha {
  readonly id: string;
  readonly kind: TipoGusto;
  readonly value: string;
  readonly source: "pedido" | "staff";
  readonly timesSeen: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly status: "activa" | "descartada";
}

export interface PedidoFicha {
  readonly id: string;
  readonly orderNumber: number | null;
  readonly createdAt: string;
  readonly status: string;
  readonly total: number;
  readonly items: readonly { readonly name: string; readonly quantity: number }[];
  readonly branch: string | null;
  readonly source: string;
  readonly paymentMethod: string | null;
  readonly pedidoFalso: boolean;
}

export interface FichaCliente {
  readonly customer: {
    readonly id: string;
    readonly name: string | null;
    readonly phone: string;
    readonly orderCount: number;
    readonly lastOrderAt: string | null;
    readonly createdAt: string;
    readonly fechaNacimientoDia: number | null;
    readonly fechaNacimientoMes: number | null;
    readonly staffNotes: string | null;
  };
  /** Nota interna (migracion 054, p. ej. la de una importacion de cartera); `null` si no hay. */
  readonly notes?: string | null;
  readonly addresses: readonly DomicilioFicha[];
  readonly preferences: readonly GustoFicha[];
  readonly reliability: { readonly noRecogidos90d: number; readonly pedidosFalsos: number; readonly umbral: number; readonly ventanaDias: number };
  readonly tier: CustomerTier | null;
  readonly orders: readonly PedidoFicha[];
  readonly whatsapp: { readonly conversaciones: number; readonly ultimaActividad: string | null; readonly mensajes: number };
  readonly llamadas: readonly { readonly id: string; readonly startedAt: string; readonly durationS: number | null; readonly resultado: string | null }[];
}

export interface CambiosDomicilio {
  readonly address?: string;
  readonly label?: string | null;
  readonly access_notes?: string | null;
  readonly maps_url?: string | null;
  readonly colonia?: string | null;
  readonly is_default?: boolean;
}

export interface PoliticaReincidencia {
  readonly umbralNoRecogidos: number;
  readonly ventanaDias: number;
}

const base = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/customers`;

export async function fetchFichaCliente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<FichaCliente> {
  const body = await fetchJson<{ ficha: FichaCliente }>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/ficha`, token);
  return body.ficha;
}

export async function actualizarPerfilCliente(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  customerId: string,
  cambios: { name?: string | null; staffNotes?: string | null; fechaNacimientoDia?: number | null; fechaNacimientoMes?: number | null },
): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}`, token, "PATCH", cambios);
}

export async function guardarDomicilio(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  customerId: string,
  addressId: string | null,
  cambios: CambiosDomicilio,
): Promise<void> {
  const url = `${apiBaseUrl}${base(propertyId)}/${customerId}/addresses${addressId ? `/${addressId}` : ""}`;
  await sendJson(fetchImpl, url, token, addressId ? "PATCH" : "POST", cambios);
}

export async function borrarDomicilio(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string, addressId: string): Promise<void> {
  await deleteJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/addresses/${addressId}`, token);
}

export async function accionGusto(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  customerId: string,
  accion: { accion: "agregar"; kind: TipoGusto; value: string } | { accion: "descartar" | "reactivar" | "eliminar"; prefId: string },
): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/preferences`, token, "POST", accion);
}

export async function marcarPedidoFalso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string, orderId: string, falso: boolean): Promise<void> {
  await sendJson(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/orders/${orderId}/falso`, token, "POST", { falso });
}

export async function fetchPoliticaReincidencia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PoliticaReincidencia> {
  const body = await fetchJson<{ policy: PoliticaReincidencia }>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/policy`, token);
  return body.policy;
}

export async function guardarPoliticaReincidencia(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, politica: PoliticaReincidencia): Promise<PoliticaReincidencia> {
  const body = await sendJson<{ policy: PoliticaReincidencia }>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/policy`, token, "PUT", politica);
  return body.policy;
}

export async function exportarDatosCliente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<Record<string, unknown>> {
  const body = await fetchJson<{ datos: Record<string, unknown> }>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/arco-export`, token);
  return body.datos;
}

export async function borrarMemoriaCliente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<{ domiciliosBorrados: number; gustosBorrados: number }> {
  const body = await sendJson<{ resultado: { domiciliosBorrados: number; gustosBorrados: number } }>(fetchImpl, `${apiBaseUrl}${base(propertyId)}/${customerId}/borrar-memoria`, token, "POST", {});
  return body.resultado;
}

// ---- Cartera por nivel (filtros, KPIs) e importacion -------------------------------------------------------------------------------

export type FrecuenciaCliente = "una_vez" | "recurrentes";

export interface CarteraFiltros {
  readonly nivel?: CustomerTier;
  readonly frecuencia?: FrecuenciaCliente;
  readonly inactivoDias?: number;
  readonly branchId?: string;
}

export interface CarteraKpisWire {
  /** `false` = la base aun no tiene la migracion 054. */
  readonly disponible: boolean;
  readonly total?: number;
  readonly recurrentes?: number;
  readonly ticketPromedio?: number | null;
  readonly masFrecuente?: { readonly nombre: string | null; readonly telefonoEnmascarado: string; readonly pedidos: number; readonly diasDesdeUltimoPedido: number | null } | null;
}

export async function fetchCarteraKpis(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<CarteraKpisWire> {
  return fetchJson<CarteraKpisWire>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers/kpis`, token);
}

export interface ErrorRenglonImportacionWire {
  readonly renglon: number;
  readonly motivo: string;
}

export interface VistaPreviaImportacionWire {
  readonly total: number;
  readonly validos: number;
  readonly duplicadosEnArchivo: number;
  readonly totalErrores: number;
  readonly errores: readonly ErrorRenglonImportacionWire[];
  readonly muestra: ReadonlyArray<{ readonly nombre: string | null; readonly telefonoEnmascarado: string; readonly direccion: string | null; readonly notas: string | null }>;
}

export interface ResultadoImportacionWire {
  readonly yaImportado: boolean;
  readonly total: number;
  readonly creados: number;
  readonly actualizados: number;
  readonly sinCambios: number;
  readonly rechazados: number;
  readonly errores: readonly ErrorRenglonImportacionWire[];
}

export interface FilaImportacionCrudaWire {
  readonly telefono: string;
  readonly nombre: string;
  readonly direccion: string;
  readonly colonia: string;
  readonly notas: string;
}

export async function vistaPreviaImportacionClientes(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  huella: string,
  filas: readonly FilaImportacionCrudaWire[],
): Promise<VistaPreviaImportacionWire> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers/import/preview`, token, "POST", { huella, filas });
}

export async function importarClientes(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  huella: string,
  filas: readonly FilaImportacionCrudaWire[],
): Promise<ResultadoImportacionWire> {
  const body = await sendJson<{ resultado: ResultadoImportacionWire }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers/import`, token, "POST", { huella, filas });
  return body.resultado;
}
