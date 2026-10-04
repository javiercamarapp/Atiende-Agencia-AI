// Llamadas del Cerebro (mapa y ficha) al API de plataforma. Todas son del superadmin: el token viaja en cada peticion y el step-up lo
// resuelve `fetchJson`. Lo que el API no pudo dar (base sin migrar) llega como `disponible: false`, nunca como una lista vacia.
import { fetchJson } from "../lib/fetch-json.ts";
import type { RespuestaDetalleApi, RespuestaProspectosApi } from "./datos.ts";

export function cargarCartera(apiBaseUrl: string, token: string): Promise<RespuestaProspectosApi> {
  return fetchJson<RespuestaProspectosApi>(apiBaseUrl, token, "/superadmin/cerebro/prospectos");
}

export function cargarDetalle(apiBaseUrl: string, token: string, id: string): Promise<RespuestaDetalleApi> {
  return fetchJson<RespuestaDetalleApi>(apiBaseUrl, token, `/superadmin/cerebro/prospectos/${encodeURIComponent(id)}/detalle`);
}

export interface ResultadoExportacion {
  /** `false` = la bitacora no esta disponible en este despliegue (se avisa en pantalla; la exportacion no se oculta). */
  readonly registrada: boolean;
}

/** Deja el rastro de la exportacion ANTES de armar el archivo. Si lanza, la pantalla NO exporta. */
export function registrarExportacion(apiBaseUrl: string, token: string, total: number, filtros: Readonly<Record<string, unknown>>): Promise<ResultadoExportacion> {
  return fetchJson<ResultadoExportacion>(apiBaseUrl, token, "/superadmin/cerebro/exportaciones", { method: "POST", body: JSON.stringify({ total, filtros }) });
}
