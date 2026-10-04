// R-17 -- cliente de la exportacion de Historial y Clientes (apps/api .../admin/exportar/historial|clientes). Pide el archivo al servidor
// (con la misma sesion y refresco de token que el resto del panel) y lo entrega al navegador como descarga. Nada se genera en el navegador:
// el CSV/PDF lo arma el servidor con RLS del usuario, el tope de filas y la bitacora.
import { apiBaseUrlFromRequestUrl, readErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { RestaurantesAdminError, defaultAuthCtx } from "./admin-client.ts";

export type FormatoExportacion = "csv" | "pdf";

export interface FiltrosExportarHistorial {
  readonly status?: string;
  /** ISO 8601, mismos limites que la pantalla de Historial (medianoche local de la persona). */
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export function urlExportarHistorial(apiBaseUrl: string, propertyId: string, formato: FormatoExportacion, f: FiltrosExportarHistorial): string {
  const p = new URLSearchParams({ formato });
  if (f.status) p.set("status", f.status);
  if (f.dateFrom) p.set("dateFrom", f.dateFrom);
  if (f.dateTo) p.set("dateTo", f.dateTo);
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/exportar/historial?${p.toString()}`;
}

export function urlExportarClientes(apiBaseUrl: string, propertyId: string, formato: FormatoExportacion, search?: string): string {
  const p = new URLSearchParams({ formato });
  if (search) p.set("search", search);
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/exportar/clientes?${p.toString()}`;
}

export interface ArchivoExportado {
  readonly blob: Blob;
  readonly nombre: string;
}

function nombreDeContentDisposition(valor: string | null, respaldo: string): string {
  const m = valor?.match(/filename="([^"\\/]+)"/);
  return m?.[1] ?? respaldo;
}

export async function descargarExportacion(fetchImpl: typeof fetch, url: string, token: string, formato: FormatoExportacion): Promise<ArchivoExportado> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) throw new RestaurantesAdminError(await readErrorMessage(res, `No se pudo exportar (${res.status}).`));
  return { blob: await res.blob(), nombre: nombreDeContentDisposition(res.headers.get("content-disposition"), `atiende-exportacion.${formato}`) };
}

/** Entrega el archivo al navegador (ancla temporal con `download`). */
export function guardarArchivo(archivo: ArchivoExportado, doc: Document = document): void {
  const url = URL.createObjectURL(archivo.blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = archivo.nombre;
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
