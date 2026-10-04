// Lógica de datos de Clientes (Fase 5) — listado/búsqueda + ficha real sobre
// apps/api/src/routes/verticals/restaurantes/admin-customers.ts. Nunca inventa
// campos: la ficha es exactamente el mismo shape que
// `@atiende/domain-restaurantes::CustomerLookupResult` (tier real, "lo de siempre"
// real, direcciones guardadas).
import { fetchJson, sendJson } from "./admin-client.ts";

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
