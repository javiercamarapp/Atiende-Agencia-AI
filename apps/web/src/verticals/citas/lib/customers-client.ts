// Lógica de datos de Clientes (Fase 5) — lista paginada + búsqueda + ficha con
// citas próximas reales. `listCustomers`/`findCustomerById` son las únicas 2
// funciones nuevas que se agregaron a `CitasRepository` para esta fase (ver
// packages/domain-citas/src/repository.ts) — puro listado/paginado de filas que
// `upsertCustomer` ya escribía desde Fase 1, ninguna regla de negocio nueva sobre
// el cliente mismo (nunca se crea/edita un cliente desde el panel).
import { fetchJson, sendJson } from "./admin-client.ts";
import type { AppointmentApiRow, AppointmentSummary } from "./appointments-client.ts";
import { mapAppointmentRow } from "./appointments-client.ts";

export interface CustomerSummary {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
}

interface CustomerApiRow {
  readonly id: string;
  readonly full_name: string;
  readonly phone: string;
  readonly email: string | null;
}

function mapCustomer(row: CustomerApiRow): CustomerSummary {
  return { id: row.id, fullName: row.full_name, phone: row.phone, email: row.email };
}

export interface CustomerPage {
  readonly items: readonly CustomerSummary[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface FetchCustomersOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly search?: string;
}

export async function fetchCustomers(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opts: FetchCustomersOptions = {}): Promise<CustomerPage> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.search) params.set("search", opts.search);
  const qs = params.toString();
  const body = await fetchJson<{ customers: readonly CustomerApiRow[]; total: number; next_offset: number | null }>(
    fetchImpl,
    `${apiBaseUrl}/v1/citas/properties/${propertyId}/customers${qs ? `?${qs}` : ""}`,
    token,
  );
  return { items: body.customers.map(mapCustomer), total: body.total, nextOffset: body.next_offset };
}

export interface CustomerDetail {
  readonly customer: CustomerSummary;
  readonly upcomingAppointments: readonly AppointmentSummary[];
}

export async function fetchCustomerDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string): Promise<CustomerDetail> {
  const body = await fetchJson<{ customer: CustomerApiRow; upcoming_appointments: readonly AppointmentApiRow[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/customers/${customerId}`, token);
  return { customer: mapCustomer(body.customer), upcomingAppointments: body.upcoming_appointments.map(mapAppointmentRow) };
}

/** Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — captura/edición del
 * correo OPCIONAL de un cliente ya existente (ver apps/api/.../citas/admin.ts::
 * PATCH .../customers/:customerId). `email: null` (o `""`, tratado igual) quita
 * el correo guardado -- NUNCA es obligatorio. */
export async function updateCustomerEmail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, customerId: string, email: string | null): Promise<CustomerSummary> {
  const body = await sendJson<{ customer: CustomerApiRow }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/customers/${customerId}`, token, "PATCH", { email: email || null });
  return mapCustomer(body.customer);
}
