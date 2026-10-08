// CFO-07 · cliente HTTP tipado de `/v1/restaurantes/:propertyId/admin/cfo/*` (CFO-05). Los tipos de respuesta salen de
// `@atiende/domain-restaurantes/cfo` (`tipos-api.ts`); no se duplican aquí.
//
// Mismo criterio que `lib/cierres-client.ts` / `lib/voz-client.ts` (`fetchImpl` inyectado, `withAuthRefresh`):
//  - 404/503 o `disponible: false` (la base aún no tiene la migración) -> `VozNoDisponibleError`: la pantalla muestra un estado honesto.
//  - 403 -> `CfoSinAccesoError`: «Tu rol no tiene acceso al CFO» (fail-closed: nunca se pinta nada del tablero).
//  - Nunca se inventan cifras: lo que no llega se queda como null.
import type {
  AlcanceVista,
  ConceptoCosto,
  ConfigVista,
  CostoHistorialVista,
  CostoVista,
  CriterioOrden,
  EstadoResultadosVista,
  FiltroPedidosDetalle,
  Granularidad,
  PedidosVista,
  ResumenVista,
  SucursalesVista,
  VentasVista,
  VistaExportacionCfo,
  CfoConfig,
} from "@atiende/domain-restaurantes/cfo";
import { apiBaseUrlFromRequestUrl, readErrorMessage, readWriteErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { RestaurantesAdminError, defaultAuthCtx } from "../lib/admin-client.ts";
import { guardarArchivo, type ArchivoExportado } from "../lib/exportar-client.ts";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { consultaApi, type FiltrosCfo } from "./filtros-url.ts";

export { guardarArchivo };
export type { ArchivoExportado };

export const MENSAJE_SIN_ACCESO_CFO = "Tu rol no tiene acceso al CFO";

/** 403 del API: el rol no puede ver el CFO (o el alcance pedido). */
export class CfoSinAccesoError extends Error {
  constructor() {
    super(MENSAJE_SIN_ACCESO_CFO);
    this.name = "CfoSinAccesoError";
  }
}

/** La ruta de exportación (CFO-06) todavía no existe en este despliegue (404): el botón se oculta. */
export class CfoExportarNoDisponibleError extends Error {
  constructor() {
    super("La exportación del CFO todavía no está disponible en este despliegue.");
    this.name = "CfoExportarNoDisponibleError";
  }
}

export const baseCfo = (apiBaseUrl: string, propertyId: string): string => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/cfo`;

async function pedirCfo<T>(fetchImpl: typeof fetch, url: string, token: string, init: { method: "GET" | "PUT"; body?: unknown }): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, {
      method: init.method,
      headers: init.method === "GET" ? { authorization: `Bearer ${t}` } : { authorization: `Bearer ${t}`, "content-type": "application/json" },
      ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }),
    }),
  );
  // Una LECTURA con 403 = el rol no puede ver el CFO. Una ESCRITURA con 403 = el rol lo ve pero no puede capturar eso (p. ej. costos de la organización
  // siendo un admin acotado): el mensaje del servidor explica por qué y se muestra tal cual en el diálogo.
  if (res.status === 403 && init.method === "GET") throw new CfoSinAccesoError();
  if (res.status === 404 || res.status === 503) throw new VozNoDisponibleError(res.status);
  if (!res.ok) {
    const fallback = `No se pudo completar la solicitud al CFO (${res.status}).`;
    throw new RestaurantesAdminError(init.method === "GET" ? await readErrorMessage(res, fallback) : await readWriteErrorMessage(res, fallback));
  }
  return (await res.json()) as T;
}

/** Lectura con la convención `disponible: false` = base sin migrar. */
async function leer<T extends { readonly disponible?: boolean }>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const w = await pedirCfo<T>(fetchImpl, url, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w;
}

export interface ContextoCfo {
  readonly fetchImpl: typeof fetch;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}

const url = (c: ContextoCfo, ruta: string, q?: URLSearchParams): string => `${baseCfo(c.apiBaseUrl, c.propertyId)}${ruta}${q && q.size > 0 ? `?${q.toString()}` : ""}`;

/** Alcance del actor SIN filtro de sucursales: lista todas las que puede ver (la selección de la barra se aplica en cada vista). */
export function fetchAlcance(c: ContextoCfo): Promise<AlcanceVista> {
  return leer<AlcanceVista>(c.fetchImpl, url(c, "/alcance"), c.token);
}

export function fetchResumen(c: ContextoCfo, f: FiltrosCfo, orden: CriterioOrden): Promise<ResumenVista> {
  return leer<ResumenVista>(c.fetchImpl, url(c, "/resumen", consultaApi(f, { orden })), c.token);
}

export function fetchVentas(c: ContextoCfo, f: FiltrosCfo, granularidad: Granularidad): Promise<VentasVista> {
  return leer<VentasVista>(c.fetchImpl, url(c, "/ventas", consultaApi(f, { granularidad })), c.token);
}

export function fetchSucursales(c: ContextoCfo, f: FiltrosCfo): Promise<SucursalesVista> {
  return leer<SucursalesVista>(c.fetchImpl, url(c, "/sucursales", consultaApi(f)), c.token);
}

export function fetchEstadoResultados(c: ContextoCfo, f: FiltrosCfo, granularidad: Granularidad): Promise<EstadoResultadosVista> {
  return leer<EstadoResultadosVista>(c.fetchImpl, url(c, "/estado-resultados", consultaApi(f, { granularidad })), c.token);
}

export interface ParametrosPedidos {
  readonly filtro: FiltroPedidosDetalle;
  readonly cursor?: string | null;
  readonly limite?: number;
}

export function fetchPedidos(c: ContextoCfo, f: FiltrosCfo, p: ParametrosPedidos): Promise<PedidosVista> {
  const filtroJson = Object.keys(p.filtro).length > 0 ? JSON.stringify(p.filtro) : undefined;
  return leer<PedidosVista>(c.fetchImpl, url(c, "/pedidos", consultaApi(f, { filtro: filtroJson, cursor: p.cursor ?? undefined, limite: String(p.limite ?? 25) })), c.token);
}

export function fetchConfig(c: ContextoCfo): Promise<ConfigVista> {
  return leer<ConfigVista>(c.fetchImpl, url(c, "/config"), c.token);
}

/** Solo las llaves que cambian (camelCase). `comisionTerminalPct: null` = volver a «captura pendiente». */
export type CambiosConfigCfo = Partial<{ -readonly [K in keyof CfoConfig]: CfoConfig[K] }>;

export function guardarConfig(c: ContextoCfo, cambios: CambiosConfigCfo): Promise<ConfigVista> {
  return pedirCfo<ConfigVista>(c.fetchImpl, url(c, "/config"), c.token, { method: "PUT", body: cambios });
}

/** `mesDesde`/`mesHasta`: `YYYY-MM` o `YYYY-MM-01`. */
export function fetchCostos(c: ContextoCfo, mesDesde: string, mesHasta: string, sucursales?: readonly string[] | null): Promise<CostoVista> {
  const q = new URLSearchParams({ mesDesde, mesHasta });
  if (sucursales) q.set("sucursales", sucursales.join(","));
  return leer<CostoVista>(c.fetchImpl, url(c, "/costos", q), c.token);
}

export function fetchCostoHistorial(c: ContextoCfo, propertyId: string | null, mes: string, concepto: ConceptoCosto): Promise<CostoHistorialVista> {
  const q = new URLSearchParams({ propertyId: propertyId ?? "organizacion", mes, concepto });
  return leer<CostoHistorialVista>(c.fetchImpl, url(c, "/costos/historial", q), c.token);
}

export interface CostoAGuardar {
  /** null = costo de la organización («No asignado»): solo dueño o administrador de toda la organización. */
  readonly propertyId: string | null;
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly concepto: ConceptoCosto;
  readonly montoCentavos: number | null;
  readonly pct: number | null;
  readonly nota: string | null;
}

export type CostosGuardados = CostoVista & { readonly guardados: number; readonly ids: readonly string[] };

export function guardarCostos(c: ContextoCfo, costos: readonly CostoAGuardar[]): Promise<CostosGuardados> {
  return pedirCfo<CostosGuardados>(c.fetchImpl, url(c, "/costos"), c.token, { method: "PUT", body: { costos } });
}

// ---- Exportar (CFO-06): GET .../admin/cfo/exportar?formato=xlsx|pdf&vista=... --------------------------------------------------------

export type FormatoExportacionCfo = "xlsx" | "pdf";

export function urlExportarCfo(c: Pick<ContextoCfo, "apiBaseUrl" | "propertyId">, f: FiltrosCfo, vista: VistaExportacionCfo, formato: FormatoExportacionCfo): string {
  return `${baseCfo(c.apiBaseUrl, c.propertyId)}/exportar?${consultaApi(f, { formato, vista }).toString()}`;
}

function nombreDeContentDisposition(valor: string | null, respaldo: string): string {
  const m = valor?.match(/filename="([^"\\/]+)"/);
  return m?.[1] ?? respaldo;
}

export async function descargarExportacionCfo(c: ContextoCfo, f: FiltrosCfo, vista: VistaExportacionCfo, formato: FormatoExportacionCfo): Promise<ArchivoExportado> {
  const u = urlExportarCfo(c, f, vista, formato);
  const res = await withAuthRefresh(c.fetchImpl, apiBaseUrlFromRequestUrl(u), defaultAuthCtx(), c.token, (t) => c.fetchImpl(u, { headers: { authorization: `Bearer ${t}` } }));
  if (res.status === 403) throw new CfoSinAccesoError();
  if (res.status === 404) throw new CfoExportarNoDisponibleError();
  if (!res.ok) throw new RestaurantesAdminError(await readErrorMessage(res, `No se pudo exportar (${res.status}).`));
  return { blob: await res.blob(), nombre: nombreDeContentDisposition(res.headers.get("content-disposition"), `atiende-cfo-${vista}.${formato}`) };
}
