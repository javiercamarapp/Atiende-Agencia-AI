// C-02 -- cliente del seguimiento de solicitudes ARCO (ver
// apps/api/src/routes/verticals/citas/privacidad.ts).
import type { SolicitudArcoAccion, SolicitudArcoDerecho, SolicitudArcoEstado, SolicitudArcoVista } from "@atiende/ui";
import { fetchJson, sendJson } from "./admin-client.ts";

export interface SolicitudesArcoPagina {
  /** `false` cuando la migración todavía no está aplicada: nunca confundir con vacío. */
  readonly disponible: boolean;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly plazos: { readonly respuestaDias: number; readonly ejecucionDias: number };
  readonly items: readonly SolicitudArcoVista[];
}

export interface SolicitudesArcoFiltro {
  readonly estado?: SolicitudArcoEstado | null;
  readonly derecho?: SolicitudArcoDerecho | null;
  readonly limit?: number;
  readonly offset?: number;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/privacidad/solicitudes`;

export async function fetchSolicitudesArco(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtro: SolicitudesArcoFiltro = {}): Promise<SolicitudesArcoPagina> {
  const params = new URLSearchParams();
  if (filtro.estado) params.set("estado", filtro.estado);
  if (filtro.derecho) params.set("derecho", filtro.derecho);
  if (filtro.limit !== undefined) params.set("limit", String(filtro.limit));
  if (filtro.offset !== undefined) params.set("offset", String(filtro.offset));
  const query = params.toString();
  return fetchJson<SolicitudesArcoPagina>(fetchImpl, `${base(apiBaseUrl, propertyId)}${query ? `?${query}` : ""}`, token);
}

export async function actualizarEstadoSolicitudArco(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  requestId: string,
  estado: SolicitudArcoAccion,
  nota: string | null,
): Promise<{ id: string; estado: SolicitudArcoEstado }> {
  return sendJson<{ id: string; estado: SolicitudArcoEstado }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${requestId}/estado`, token, "PATCH", nota ? { estado, nota } : { estado });
}
