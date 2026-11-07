// Analítica del dueño (F7) · cliente HTTP tipado de `/v1/restaurantes/:propertyId/admin/analitica/*`. Misma convención del CFO: 403 => sin acceso (fail-closed),
// 404/503 o `disponible: false` => estado honesto «no disponible» (base sin migrar). Los tipos salen de `@atiende/domain-restaurantes/analitica`.
import type { VistaDemanda, VistaProductos, VistaRatios, VistaZonas } from "@atiende/domain-restaurantes/analitica";
import { leer, pedirCfo, type ContextoCfo } from "./cfo-client.ts";
import { consultaApi, type FiltrosCfo } from "./filtros-url.ts";

const url = (c: ContextoCfo, ruta: string, q: URLSearchParams): string => `${c.apiBaseUrl}/v1/restaurantes/${c.propertyId}/admin/analitica${ruta}?${q.toString()}`;

export function fetchDemanda(c: ContextoCfo, f: FiltrosCfo): Promise<VistaDemanda & { readonly disponible: true }> {
  return leer<VistaDemanda & { readonly disponible: true }>(c.fetchImpl, url(c, "/demanda", consultaApi(f)), c.token);
}
export function fetchZonas(c: ContextoCfo, f: FiltrosCfo): Promise<VistaZonas & { readonly disponible: true }> {
  return leer<VistaZonas & { readonly disponible: true }>(c.fetchImpl, url(c, "/zonas", consultaApi(f)), c.token);
}
export function fetchProductosCombos(c: ContextoCfo, f: FiltrosCfo): Promise<VistaProductos & { readonly disponible: true }> {
  return leer<VistaProductos & { readonly disponible: true }>(c.fetchImpl, url(c, "/productos", consultaApi(f)), c.token);
}
export function fetchRatios(c: ContextoCfo, f: FiltrosCfo): Promise<VistaRatios & { readonly disponible: true }> {
  return leer<VistaRatios & { readonly disponible: true }>(c.fetchImpl, url(c, "/ratios", consultaApi(f)), c.token);
}

/** Costo unitario de un producto en pesos (null borra). Solo dueño/administrador de toda la organización. */
export function guardarCostoProducto(c: ContextoCfo, productId: string, costo: number | null): Promise<{ readonly guardado: boolean }> {
  return pedirCfo<{ guardado: boolean }>(c.fetchImpl, `${c.apiBaseUrl}/v1/restaurantes/${c.propertyId}/admin/analitica/productos/${productId}/costo`, c.token, { method: "PUT", body: { costo } });
}
