// Pin de sucursal: busqueda de direcciones y direccion de un punto, SIEMPRE por la API propia (GET .../admin/geocodificar[/inverso]).
// El navegador nunca habla con el proveedor de mapas ni ve su llave. Un 503 (proveedor sin configurar o caido) es un estado honesto:
// el panel lo dice y sigue aceptando coordenadas pegadas de Google Maps.
import { apiBaseUrlFromRequestUrl, readErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { defaultAuthCtx } from "./admin-client.ts";

export interface ResultadoDireccion {
  readonly etiqueta: string;
  readonly lat: number;
  readonly lng: number;
}

/** 503: la busqueda no esta disponible (sin configurar o el proveedor no respondio). `message` trae el texto del servidor. */
export class GeocodificacionNoDisponibleError extends Error {}
export class GeocodificacionError extends Error {}

async function pedir<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (res.status === 503) throw new GeocodificacionNoDisponibleError(await readErrorMessage(res, "La búsqueda de direcciones no está disponible."));
  if (!res.ok) throw new GeocodificacionError(await readErrorMessage(res, `No se pudo buscar la dirección (${res.status}).`));
  return (await res.json()) as T;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${encodeURIComponent(propertyId)}/admin/geocodificar`;

export async function buscarDireccion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, q: string): Promise<readonly ResultadoDireccion[]> {
  const body = await pedir<{ resultados?: unknown }>(fetchImpl, `${base(apiBaseUrl, propertyId)}?q=${encodeURIComponent(q.trim())}`, token);
  if (!Array.isArray(body.resultados)) return [];
  return body.resultados.filter(
    (r): r is ResultadoDireccion => typeof r === "object" && r !== null && typeof r.etiqueta === "string" && Number.isFinite(r.lat) && Number.isFinite(r.lng),
  );
}

export async function direccionDePunto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, lat: number, lng: number): Promise<string | null> {
  const body = await pedir<{ etiqueta?: unknown }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/inverso?lat=${lat}&lng=${lng}`, token);
  return typeof body.etiqueta === "string" && body.etiqueta.trim() ? body.etiqueta : null;
}

/** Centro inicial del mapa cuando la sucursal no tiene ubicacion (Merida), el mismo del original. */
export const CENTRO_MERIDA = { lat: 20.98, lng: -89.62 } as const;

/** Redondea a 6 decimales (~10 cm): lo que se guarda y lo que se muestra en los campos. */
export function redondearCoordenada(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
