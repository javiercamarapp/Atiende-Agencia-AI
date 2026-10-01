// PM PR-9 -- cliente de privacidad de restaurantes: solicitudes ARCO y configuracion (ver
// apps/api/src/routes/verticals/restaurantes/privacidad.ts). Montado sobre `:propertyId` como el resto
// de rutas admin de este vertical.
import type { SolicitudArcoAccion, SolicitudArcoDerecho, SolicitudArcoEstado, SolicitudArcoVista } from "@atiende/ui";
import { fetchJson, sendJson } from "./admin-client.ts";

export interface SolicitudesArcoPagina {
  /** `false` cuando la migracion todavia no esta aplicada: nunca confundir con vacio. */
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

export interface ConfiguracionPrivacidad {
  readonly responsable: string | null;
  readonly avisoUrl: string | null;
  readonly avisoVersion: string;
  readonly retencionConversacionesDias: number;
  readonly retencionVozDias: number;
  readonly exigirConsentimientoGrabacion: boolean;
  /** `false` = nunca se guardo (o la base no esta migrada): son los valores por defecto. */
  readonly configurada: boolean;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/privacidad`;

export async function fetchSolicitudesArco(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtro: SolicitudesArcoFiltro = {}): Promise<SolicitudesArcoPagina> {
  const params = new URLSearchParams();
  if (filtro.estado) params.set("estado", filtro.estado);
  if (filtro.derecho) params.set("derecho", filtro.derecho);
  if (filtro.limit !== undefined) params.set("limit", String(filtro.limit));
  if (filtro.offset !== undefined) params.set("offset", String(filtro.offset));
  const query = params.toString();
  return fetchJson<SolicitudesArcoPagina>(fetchImpl, `${base(apiBaseUrl, propertyId)}/solicitudes${query ? `?${query}` : ""}`, token);
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
  return sendJson<{ id: string; estado: SolicitudArcoEstado }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/solicitudes/${requestId}/estado`, token, "PATCH", nota ? { estado, nota } : { estado });
}

export async function fetchConfiguracionPrivacidad(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConfiguracionPrivacidad> {
  const body = await fetchJson<{ configuracion: ConfiguracionPrivacidad }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion`, token);
  return body.configuracion;
}

export async function guardarConfiguracionPrivacidad(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  config: Omit<ConfiguracionPrivacidad, "configurada">,
): Promise<ConfiguracionPrivacidad> {
  const body = await sendJson<{ configuracion: ConfiguracionPrivacidad }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/configuracion`, token, "PUT", config);
  return body.configuracion;
}
