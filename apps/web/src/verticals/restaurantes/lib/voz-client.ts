// Cliente HTTP tipado hacia los endpoints de voz de la API propia (config por
// sucursal, sesión de vista previa con token efímero, conversaciones). Esos
// endpoints los construye OTRA tarea: si todavía no existen (404) o el servicio de
// voz está apagado (503), este cliente lanza `VozNoDisponibleError` y la interfaz
// muestra un estado honesto; nunca inventa datos.
//
// Mismo criterio que el resto de lib/*.ts: `fetchImpl` inyectado y renovación de
// sesión vía `withAuthRefresh` (un 401 intenta un refresh y reintenta una vez).
import { apiBaseUrlFromRequestUrl, readErrorMessage, readWriteErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { defaultAuthCtx, RestaurantesAdminError } from "./admin-client.ts";

/** Config de voz de UNA sucursal (un registro por `propertyId`). */
export interface VozConfig {
  /** Nombre de la voz predefinida de Gemini (ver voz-catalogo.ts), o null si no se ha elegido. */
  readonly vozId: string | null;
  readonly promptSistema: string;
  readonly mensajeInicial: string;
  /** Notas de conocimiento libres (horarios, políticas) que el agente recibe como contexto. */
  readonly conocimiento: string;
  readonly actualizadoEn: string | null;
}

export type VozConfigInput = Pick<VozConfig, "vozId" | "promptSistema" | "mensajeInicial" | "conocimiento">;

/** Sesión de vista previa: el token es efímero y de un solo uso, nunca una API key. */
export interface SesionPreviewVoz {
  readonly sessionId: string;
  readonly token: string;
  readonly expiraEn: string;
  readonly wsUrl?: string;
}

export type ResultadoConversacion = "pedido" | "consulta" | "abandonada" | "error";

export interface LineaConversacion {
  readonly rol: "agente" | "usuario";
  readonly texto: string;
  readonly ts: number;
}

export interface ConversacionVoz {
  readonly id: string;
  readonly iniciadaEn: string;
  readonly duracionSegundos: number | null;
  /** Costo del modelo en USD; null si aún no se calculó. */
  readonly costoUsd: number | null;
  readonly resultado: ResultadoConversacion | null;
  /** Transcripción completa; puede venir ausente en el listado. */
  readonly transcripcion?: readonly LineaConversacion[];
  /** Nombres de las herramientas que el agente ejecutó en esta llamada, si el servicio los reporta. */
  readonly herramientas?: readonly string[];
}

/** El endpoint no existe todavía (404) o el servicio está apagado (503). */
export class VozNoDisponibleError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("El servicio de voz todavía no está disponible para este negocio.");
    this.name = "VozNoDisponibleError";
    this.status = status;
  }
}

function esNoDisponible(status: number): boolean {
  return status === 404 || status === 503;
}

function base(apiBaseUrl: string, propertyId: string): string {
  return `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/voz`;
}

async function pedir<T>(fetchImpl: typeof fetch, url: string, token: string, init: { method: "GET" | "PUT" | "POST"; body?: unknown }): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, {
      method: init.method,
      headers: init.method === "GET" ? { authorization: `Bearer ${t}` } : { authorization: `Bearer ${t}`, "content-type": "application/json" },
      ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body ?? {}) }),
    }),
  );
  if (esNoDisponible(res.status)) throw new VozNoDisponibleError(res.status);
  if (!res.ok) {
    const fallback = `No se pudo completar la solicitud a ${url} (${res.status}).`;
    throw new RestaurantesAdminError(init.method === "GET" ? await readErrorMessage(res, fallback) : await readWriteErrorMessage(res, fallback));
  }
  return (await res.json()) as T;
}

/** `null` = el servicio existe pero esta sucursal todavía no tiene configuración guardada. */
export async function fetchVozConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<VozConfig | null> {
  const body = await pedir<{ config: VozConfig | null }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "GET" });
  return body.config ?? null;
}

export async function updateVozConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: VozConfigInput): Promise<VozConfig> {
  const body = await pedir<{ config: VozConfig }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "PUT", body: input });
  return body.config;
}

export async function crearSesionPreviewVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, opts: { readonly vozId?: string } = {}): Promise<SesionPreviewVoz> {
  return pedir<SesionPreviewVoz>(fetchImpl, `${base(apiBaseUrl, propertyId)}/sesion`, token, { method: "POST", body: opts });
}

export async function fetchConversacionesVoz(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, limite = 50): Promise<readonly ConversacionVoz[]> {
  const body = await pedir<{ conversaciones: ConversacionVoz[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/conversaciones?limit=${limite}`, token, { method: "GET" });
  return body.conversaciones;
}
