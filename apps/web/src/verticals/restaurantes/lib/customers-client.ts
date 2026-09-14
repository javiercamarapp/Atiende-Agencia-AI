// Lógica de datos de Clientes (Fase 5) — listado/búsqueda + ficha real sobre
// apps/api/src/routes/verticals/restaurantes/admin-customers.ts. Nunca inventa
// campos: la ficha es exactamente el mismo shape que
// `@atiende/domain-restaurantes::CustomerLookupResult` (tier real, "lo de siempre"
// real, direcciones guardadas).
import { fetchJson } from "./admin-client.ts";

export interface CustomerSummary {
  readonly id: string;
  readonly name: string | null;
  readonly phone: string;
  readonly orderCount: number;
}

export interface CustomerListPage {
  readonly customers: readonly CustomerSummary[];
  readonly nextCursor: string | null;
}

export async function fetchCustomers(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  opts: { search?: string; limit?: number; cursor?: string } = {},
): Promise<CustomerListPage> {
  const params = new URLSearchParams();
  if (opts.search) params.set("search", opts.search);
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
    };

export async function fetchCustomerDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<CustomerDetail> {
  const body = await fetchJson<{ customer: CustomerDetail }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/customers/${customerId}`, token);
  return body.customer;
}
