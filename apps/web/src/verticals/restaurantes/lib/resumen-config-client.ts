// Cliente de la configuracion del Resumen (migracion 096). Contrato: apps/api/src/routes/verticals/restaurantes/resumen-config.ts.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface ResumenConfig {
  readonly minutosPorConversacion: number | null;
  readonly metaPedidosIaPct: number | null;
  readonly metaIngresosIaPct: number | null;
}

export interface ResumenConfigVista {
  /** false = la base no tiene la migracion 096: el Resumen dice «configuralo» pero no se puede guardar todavia. */
  readonly disponible: boolean;
  readonly config: ResumenConfig;
  readonly actualizadoEn: string | null;
  readonly rangos: { readonly minutos: { readonly min: number; readonly max: number }; readonly meta: { readonly min: number; readonly max: number } };
  /** Formula explicita de las horas ahorradas (la dice el servidor, un solo lugar). */
  readonly formula: string;
}

const ruta = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/resumen/config`;

export function fetchResumenConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ResumenConfigVista> {
  return fetchJson<ResumenConfigVista>(fetchImpl, ruta(apiBaseUrl, propertyId), token);
}

export function guardarResumenConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, config: ResumenConfig): Promise<ResumenConfigVista> {
  return sendJson<ResumenConfigVista>(fetchImpl, ruta(apiBaseUrl, propertyId), token, "PUT", config);
}

/** Horas ahorradas = conversaciones atendidas × minutos por conversacion ÷ 60; `null` mientras el dueño no configure los minutos. */
export function horasAhorradas(conversaciones: number, minutosPorConversacion: number | null): number | null {
  if (minutosPorConversacion === null) return null;
  return (conversaciones * minutosPorConversacion) / 60;
}
