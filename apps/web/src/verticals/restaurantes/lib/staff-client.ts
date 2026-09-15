// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI: el panel de repartidor siempre estará vacío"): cliente real de
// `GET .../admin/staff/repartidores` (admin-staff.ts) — lista los miembros YA
// aceptados de la organización con `verticalRole === "repartidor"`, para poblar el
// selector de `PedidosPage` (ver `orders-client.ts::assignRepartidor`). Deliberadamente
// un archivo nuevo (no agregado a `orders-client.ts`): es un recurso distinto
// (staff/membership, no pedidos), mismo criterio de separación que ya usa el resto de
// este vertical (`orders-client.ts` vs. `dashboard-client.ts` vs. `catalog-client.ts`).
import { fetchJson } from "./admin-client.ts";

export interface RepartidorMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly propertyIds: readonly string[] | null;
}

export async function fetchRepartidores(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RepartidorMember[]> {
  const body = await fetchJson<{ repartidores: RepartidorMember[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/repartidores`, token);
  return body.repartidores;
}
