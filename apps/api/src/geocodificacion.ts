// Geocodificacion de direcciones DEL LADO DEL SERVIDOR (pin de sucursal en el panel de restaurantes).
//
// Por que en el servidor: el repo suelto llamaba a Nominatim desde el navegador. Aqui la llamada sale de la API para que (1) ninguna llave
// llegue al navegador, (2) el proveedor se cambie por configuracion sin desplegar el web, (3) se respete la politica de uso de Nominatim
// (identificarse con un contacto, poco volumen) con un tope por persona, y (4) un proveedor caido sea un 503 honesto, nunca un pin inventado.
//
// Configuracion (apagada por omision -> la ruta responde 503 «no disponible aun»):
//   GEOCODING_PROVIDER=nominatim  + GEOCODING_CONTACT_EMAIL (obligatorio por la politica de uso de OSM)  [+ GEOCODING_BASE_URL opcional, p. ej. Nominatim propio]
//   GEOCODING_PROVIDER=google     + GEOCODING_API_KEY (Geocoding API; la llave vive solo en el servidor)
// Sesgo: Mexico, con preferencia por Yucatan (caja de la peninsula), sin excluir lo de fuera (una sucursal puede estar en otro estado).
// Lo que se manda al proveedor es la direccion DEL NEGOCIO que escribe el dueno, nunca datos de comensales.

export interface ResultadoGeocodificacion {
  readonly etiqueta: string;
  readonly lat: number;
  readonly lng: number;
}

export interface Geocodificador {
  readonly proveedor: "nominatim" | "google";
  buscar(texto: string): Promise<readonly ResultadoGeocodificacion[]>;
  inverso(lat: number, lng: number): Promise<string | null>;
}

export type ConfigGeocodificacion =
  | { readonly proveedor: "nominatim"; readonly contacto: string; readonly urlBase: string }
  | { readonly proveedor: "google"; readonly llave: string };

/** El proveedor no respondio o respondio algo inutilizable: la ruta lo convierte en 503 (nunca un resultado inventado). */
export class GeocodificacionFallidaError extends Error {}

export const GEOCODIFICACION_MAX_RESULTADOS = 5;
export const GEOCODIFICACION_TIMEOUT_MS = 5000;
/** Caja aproximada de la peninsula de Yucatan (oeste, norte, este, sur). */
export const CAJA_YUCATAN = { oeste: -90.4, norte: 21.7, este: -86.7, sur: 17.8 } as const;
const URL_NOMINATIM = "https://nominatim.openstreetmap.org";

/** Lee la configuracion del entorno. `null` = apagada (falta el proveedor o su credencial/contacto). Nunca lanza ni imprime valores. */
export function leerConfigGeocodificacion(env: Readonly<Record<string, string | undefined>>): ConfigGeocodificacion | null {
  const proveedor = (env["GEOCODING_PROVIDER"] ?? "").trim().toLowerCase();
  if (proveedor === "nominatim") {
    const contacto = (env["GEOCODING_CONTACT_EMAIL"] ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contacto)) return null;
    const base = (env["GEOCODING_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
    return { proveedor: "nominatim", contacto, urlBase: /^https:\/\//.test(base) ? base : URL_NOMINATIM };
  }
  if (proveedor === "google") {
    const llave = (env["GEOCODING_API_KEY"] ?? "").trim();
    return llave ? { proveedor: "google", llave } : null;
  }
  return null;
}

function numero(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function coordenadaValida(lat: number | null, lng: number | null): boolean {
  return lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function texto(v: unknown, max = 300): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

async function pedirJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(GEOCODIFICACION_TIMEOUT_MS) });
  } catch {
    throw new GeocodificacionFallidaError("El servicio de mapas no respondió.");
  }
  if (!res.ok) throw new GeocodificacionFallidaError(`El servicio de mapas respondió ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new GeocodificacionFallidaError("El servicio de mapas respondió algo ilegible.");
  }
}

function nominatim(cfg: Extract<ConfigGeocodificacion, { proveedor: "nominatim" }>, fetchImpl: typeof fetch): Geocodificador {
  // Politica de uso de Nominatim: identificar la aplicacion (User-Agent) y dar un contacto (`email`).
  const headers = { "User-Agent": "Atiende/1.0 (panel de restaurantes; pin de sucursal)", "Accept-Language": "es-MX,es" };
  const email = `&email=${encodeURIComponent(cfg.contacto)}`;
  return {
    proveedor: "nominatim",
    async buscar(q) {
      const { oeste, norte, este, sur } = CAJA_YUCATAN;
      const url = `${cfg.urlBase}/search?format=jsonv2&countrycodes=mx&limit=${GEOCODIFICACION_MAX_RESULTADOS}&viewbox=${oeste},${norte},${este},${sur}&bounded=0&q=${encodeURIComponent(q)}${email}`;
      const data = await pedirJson(fetchImpl, url, headers);
      if (!Array.isArray(data)) throw new GeocodificacionFallidaError("El servicio de mapas respondió algo inesperado.");
      return data
        .map((r: Record<string, unknown>) => ({ etiqueta: texto(r["display_name"]), lat: numero(r["lat"]), lng: numero(r["lon"]) }))
        .filter((r): r is ResultadoGeocodificacion => r.etiqueta !== "" && coordenadaValida(r.lat, r.lng))
        .slice(0, GEOCODIFICACION_MAX_RESULTADOS);
    },
    async inverso(lat, lng) {
      const data = await pedirJson(fetchImpl, `${cfg.urlBase}/reverse?format=jsonv2&zoom=18&addressdetails=0&lat=${lat}&lon=${lng}${email}`, headers);
      const etiqueta = texto((data as Record<string, unknown> | null)?.["display_name"]);
      return etiqueta || null;
    },
  };
}

function google(cfg: Extract<ConfigGeocodificacion, { proveedor: "google" }>, fetchImpl: typeof fetch): Geocodificador {
  const base = "https://maps.googleapis.com/maps/api/geocode/json";
  const llave = `&key=${encodeURIComponent(cfg.llave)}`;
  function resultados(data: unknown): ResultadoGeocodificacion[] {
    const d = data as { status?: unknown; results?: unknown } | null;
    if (d?.status === "ZERO_RESULTS") return [];
    if (d?.status !== "OK" || !Array.isArray(d.results)) throw new GeocodificacionFallidaError("El servicio de mapas rechazó la búsqueda.");
    return (d.results as Array<Record<string, unknown>>)
      .map((r) => {
        const loc = ((r["geometry"] as Record<string, unknown> | undefined)?.["location"] ?? {}) as Record<string, unknown>;
        return { etiqueta: texto(r["formatted_address"]), lat: numero(loc["lat"]), lng: numero(loc["lng"]) };
      })
      .filter((r): r is ResultadoGeocodificacion => r.etiqueta !== "" && coordenadaValida(r.lat, r.lng))
      .slice(0, GEOCODIFICACION_MAX_RESULTADOS);
  }
  return {
    proveedor: "google",
    async buscar(q) {
      const { oeste, norte, este, sur } = CAJA_YUCATAN;
      return resultados(await pedirJson(fetchImpl, `${base}?language=es&region=mx&components=country:MX&bounds=${sur},${oeste}|${norte},${este}&address=${encodeURIComponent(q)}${llave}`, {}));
    },
    async inverso(lat, lng) {
      return resultados(await pedirJson(fetchImpl, `${base}?language=es&latlng=${lat},${lng}${llave}`, {}))[0]?.etiqueta ?? null;
    },
  };
}

export function crearGeocodificador(cfg: ConfigGeocodificacion | null, fetchImpl: typeof fetch): Geocodificador | null {
  if (!cfg) return null;
  return cfg.proveedor === "nominatim" ? nominatim(cfg, fetchImpl) : google(cfg, fetchImpl);
}
