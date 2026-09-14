// Lógica de datos del descubrimiento de property (Fase 12) — separada de
// RentasShell.tsx a propósito, mismo motivo que hoteles/lib/discovery-client.ts:
// probarla con vitest en entorno "node" (sin DOM) mientras el componente solo la
// conecta a estado/render real. Llama a
// GET /v1/rentas/:orgSlug/admin/propiedades de apps/api (ver
// apps/api/src/routes/verticals/rentas/admin-discovery.ts).
import { fetchJson } from "./admin-client.ts";

export interface PropertyOption {
  readonly propertyId: string;
  readonly nombre: string;
}

export async function fetchProperties(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly PropertyOption[]> {
  const body = await fetchJson<{ propiedades: readonly PropertyOption[] }>(fetchImpl, `${apiBaseUrl}/v1/rentas/${orgSlug}/admin/propiedades`, token);
  return body.propiedades;
}
