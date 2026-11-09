// «Primer valor en <30 min» -- apps/api/src/routes/verticals/restaurantes/admin-primer-valor.ts y la activacion de la 0071
// (apps/api/src/routes/alta-sucursal.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export type PasoPrimerValorId = "menu" | "horario" | "zonas" | "metodos_pago" | "probar_agente" | "activar";
export type EstadoPasoPrimerValor = "hecho" | "pendiente" | "no_disponible";

export interface PasoPrimerValor {
  readonly id: PasoPrimerValorId;
  readonly titulo: string;
  readonly detalle: string;
  readonly estado: EstadoPasoPrimerValor;
  readonly minutos: number;
  readonly pantalla: string | null;
}

export interface PrimerValor {
  readonly sucursal: { readonly propertyId: string; readonly nombre: string; readonly status: "active" | "inactive" };
  readonly pasos: readonly PasoPrimerValor[];
  readonly hechos: number;
  readonly minutosRestantes: number;
  readonly puedeActivar: boolean;
  readonly listo: boolean;
}

export function fetchPrimerValor(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PrimerValor> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/primer-valor`, token);
}

export function confirmarMetodosPago(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ ok: true }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/primer-valor/metodos-pago`, token, "POST", {});
}

export function activarSucursal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string, propertyId: string): Promise<{ status: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${orgSlug}/admin/alta-sucursal/${propertyId}/activar`, token, "POST", {});
}
