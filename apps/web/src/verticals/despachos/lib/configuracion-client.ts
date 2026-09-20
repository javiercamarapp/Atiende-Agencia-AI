// FASE 3 (producto) — zona horaria por negocio (migración 012,
// `despachos.property_config`). Cliente real de
// `apps/api/src/routes/verticals/despachos/configuracion.ts` — mismo criterio de
// `fetchImpl` inyectado que el resto de lib/*.ts de este vertical (ver
// admin-client.ts).
import { fetchJson, patchJson } from "./admin-client.ts";

export interface DespachosConfiguracion {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly zonaHoraria: string | null;
}

export async function fetchConfiguracion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<DespachosConfiguracion> {
  const body = await fetchJson<{ configuracion: DespachosConfiguracion }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/configuracion`, token);
  return body.configuracion;
}

export async function updateConfiguracion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, zonaHoraria: string | null): Promise<DespachosConfiguracion> {
  const body = await patchJson<{ configuracion: DespachosConfiguracion }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/configuracion`, token, { zona_horaria: zonaHoraria });
  return body.configuracion;
}
